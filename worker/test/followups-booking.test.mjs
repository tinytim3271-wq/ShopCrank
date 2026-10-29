import test from 'node:test';
import assert from 'node:assert/strict';
import worker, * as entry from '../src/index.js';
import {
  FOLLOWUP_CRON, dueReviewRequests, followupSettings, normalizeGoogleReviewUrl, plannedServiceReminders, runScheduledFollowups, runShopFollowups,
} from '../src/customer-followups.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { FLAGS_ON } from './helpers/growth-flags-on.mjs';
import { readFileSync } from 'node:fs';

const ORIGIN = 'https://www.shopcrank.com';
const DAY = 86400000;

function seedShop({ plan = 'solo', booking = {}, followups = {} } = {}) {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.sqlite.exec(`
    INSERT INTO shops (id, name, slug, timezone, created_at, updated_at) VALUES ('shop-a1b2c3', 'Lubbock Brake & Tire', 'shop-a1b2c3', 'America/Chicago', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('shop-a1b2c3', '${plan}', 'active', '${now}');
  `);
  const put = (type, id, data) => DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-a1b2c3', type, id, JSON.stringify({ id, ...data }), 'u', now, now).runSync();
  put('shopsettings', 'profile', { shopName: 'Lubbock Brake & Tire' });
  put('shopsettings', 'booking', { hours: 'Monday-Sunday 7:00 AM - 7:00 PM', leadMinutes: 0, services: ['Oil change', 'Brakes'], ...booking });
  put('shopsettings', 'followups', followups);
  const read = type => DB.sqlite.prepare('SELECT data_json FROM entities WHERE entity_type = ?').all(type).map(row => JSON.parse(row.data_json));
  return { DB, put, read };
}

test('Google review links accept Place IDs and Google URLs only', () => {
  assert.equal(normalizeGoogleReviewUrl('ChIJN1t_tDeuEmsRUsoyG83frY4'), 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.equal(normalizeGoogleReviewUrl('https://g.page/r/abc123/review'), 'https://g.page/r/abc123/review');
  assert.equal(normalizeGoogleReviewUrl('https://evil.example/review'), '');
  assert.equal(normalizeGoogleReviewUrl('javascript:alert(1)'), '');
});

test('completed work plans the next service once per vehicle from the latest visit', () => {
  const orders = [
    { id: 'RO-1', customer: 'Alice', vehicle: '2019 Camry', vin: 'VIN1', status: 'completed', completedAt: '2026-03-01', estimate: { lines: [{ description: 'Full synthetic oil change' }, { description: 'Tire rotation' }] } },
    { id: 'RO-2', customer: 'Alice', vehicle: '2019 Camry', vin: 'VIN1', status: 'completed', completedAt: '2026-05-01', estimate: { lines: [{ description: 'Oil change' }] } },
    { id: 'RO-3', customer: 'Ben', vehicle: 'F-150', vin: 'VIN2', status: 'in_progress', estimate: { lines: [{ description: 'Oil change' }] } },
    { id: 'RO-4', customer: 'Cy', vehicle: 'Civic', vin: 'VIN3', status: 'completed', completedAt: '2026-04-01', estimate: { lines: [{ description: 'Front brake pads', approvalStatus: 'declined' }] } },
  ];
  const planned = plannedServiceReminders(orders, [], followupSettings());
  const byService = Object.fromEntries(planned.map(item => [`${item.vin}:${item.service}`, item]));
  assert.equal(byService['VIN1:Oil change'].dueDate, '2026-11-01', 'six months after the latest oil change');
  assert.equal(byService['VIN1:Tire rotation'].dueDate, '2026-09-01');
  assert.equal(planned.filter(item => item.vin === 'VIN2').length, 0, 'unfinished work is not a service visit');
  assert.equal(planned.filter(item => item.vin === 'VIN3').length, 0, 'declined lines do not count as service');
  assert.equal(plannedServiceReminders(orders, planned, followupSettings()).length, 0, 'already tracked');
});

test('review requests go out once per customer after a paid invoice, never to opted-out phones', () => {
  const now = Date.parse('2026-10-29T18:00:00Z');
  const settings = followupSettings({ reviewRequests: { googleReviewUrl: 'https://g.page/r/abc/review' } });
  const invoices = [
    { number: 'INV-1', customer: 'Alice', phone: '806-555-0101', status: 'paid', paidAt: '2026-10-29T12:00:00Z' },
    { number: 'INV-2', customer: 'Alice', phone: '806-555-0101', status: 'paid', paidAt: '2026-10-29T13:00:00Z' },
    { number: 'INV-3', customer: 'Ben', phone: '806-555-0102', status: 'paid', paidAt: '2026-10-29T17:30:00Z' },
    { number: 'INV-4', customer: 'Cy', phone: '806-555-0103', status: 'sent', paidAt: '2026-10-29T12:00:00Z' },
    { number: 'INV-5', customer: 'Di', phone: '806-555-0104', status: 'paid', paidAt: '2026-10-29T12:00:00Z' },
    { number: 'INV-6', customer: 'Ed', phone: '806-555-0105', status: 'paid', paidAt: '2026-09-01T12:00:00Z' },
  ];
  const due = dueReviewRequests(invoices, { now, settings, optedOut: new Set(['8065550104']) });
  assert.deepEqual(due.map(item => item.invoice.number), ['INV-1']);
  assert.deepEqual(dueReviewRequests(invoices, { now, settings: followupSettings() }), [], 'no link configured, nothing sent');
});

test('the follow-up run texts due reminders and review requests and records them', async () => {
  const { DB, put, read } = seedShop({ followups: { reviewRequests: { googleReviewUrl: 'https://g.page/r/abc/review' } } });
  const now = Date.now();
  put('customers', 'Alice Brooks', { name: 'Alice Brooks', phone: '806-555-0101' });
  put('orders', 'RO-1', { customer: 'Alice Brooks', vehicle: '2019 Camry', vin: 'VIN1', status: 'completed', completedAt: new Date(now - 182 * DAY).toISOString(), estimate: { lines: [{ description: 'Oil change' }] } });
  put('invoices', 'INV-1', { number: 'INV-1', customer: 'Alice Brooks', status: 'paid', paidAt: new Date(now - 5 * 3600_000).toISOString() });
  const sent = [];
  const report = await runShopFollowups({ ...FLAGS_ON, DB }, 'shop-a1b2c3', { now, send: async message => { sent.push(message); return { provider: 'twilio', messageSid: `SM${sent.length}`, status: 'queued' }; }, bookingOrigin: ORIGIN });
  assert.equal(report.remindersCreated, 1);
  assert.equal(report.remindersSent, 1);
  assert.equal(report.reviewRequestsSent, 1);
  assert.deepEqual(sent.map(message => message.to), ['+18065550101', '+18065550101']);
  assert.match(sent[0].body, /Lubbock Brake & Tire: Oil change is due for your 2019 Camry/);
  assert.match(sent[0].body, /\/api\/book\/shop-a1b2c3/);
  assert.match(sent[1].body, /Google review\? https:\/\/g\.page\/r\/abc\/review/);
  assert.ok(read('reminders')[0].sentAt);
  assert.ok(read('invoices')[0].reviewRequestedAt);
  const logged = DB.sqlite.prepare('SELECT message_type FROM customer_messages ORDER BY message_type').all().map(row => row.message_type);
  assert.deepEqual(logged, ['reminder', 'review_request']);
  const again = await runShopFollowups({ ...FLAGS_ON, DB }, 'shop-a1b2c3', { now, send: async message => { sent.push(message); return {}; } });
  assert.equal(again.remindersSent + again.reviewRequestsSent, 0, 'nothing is sent twice');
});

test('the Worker entry exports only handlers and classes (workerd refuses to start otherwise)', () => {
  for (const [name, value] of Object.entries(entry)) {
    assert.ok(typeof value === 'function' || (name === 'default' && typeof value === 'object'), `export ${name} is a ${typeof value}`);
  }
});

test('the daily cron is configured and routed to follow-ups', () => {
  const config = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  const crons = JSON.parse(config.match(/"crons":\s*(\[[^\]]*\])/)[1]);
  assert.ok(crons.includes(FOLLOWUP_CRON), 'follow-up cron configured');
  assert.ok(crons.some(cron => cron !== FOLLOWUP_CRON), 'revenue recognition keeps its own cron');
});

test('online booking works on the Solo plan: page, slots, booking, and rate limit', async () => {
  const { DB, read } = seedShop({ plan: 'solo' });
  const env = { ...FLAGS_ON, DB };
  const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}/api/book/shop-a1b2c3${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...(init.headers || {}) } }), env, {});
  const page = await call('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Lubbock Brake &amp; Tire/);
  assert.match(html, /<option>Oil change<\/option>/);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
  const slots = await (await call('/slots')).json();
  const [{ date, slots: times }] = slots.days;
  const booked = await call('', { method: 'POST', body: JSON.stringify({ customerName: 'Pat Online', phone: '806 555 0199', vehicle: '2020 Accord', service: 'Oil change', date, time: times[0] }) });
  assert.equal(booked.status, 201, await booked.clone().text());
  const [appointment] = read('appointments');
  assert.equal(appointment.source, 'online_booking');
  assert.equal(appointment.phone, '+18065550199');
  assert.equal(read('customers')[0].name, 'Pat Online');
  const invalid = await call('', { method: 'POST', body: JSON.stringify({ customerName: 'X', phone: '12', vehicle: 'Y', service: 'Z', date, time: times[0] }) });
  assert.equal(invalid.status, 400);
  let status = 0;
  for (let i = 0; i < 8; i += 1) status = (await call('', { method: 'POST', body: '{}' })).status;
  assert.equal(status, 429);
});

test('online booking is hidden when the shop turns it off or the subscription lapsed', async () => {
  const off = seedShop({ booking: { enabled: false } });
  const response = await worker.fetch(new Request(`${ORIGIN}/api/book/shop-a1b2c3`), { ...FLAGS_ON, DB: off.DB }, {});
  assert.equal(response.status, 404);
  const lapsed = seedShop();
  lapsed.DB.sqlite.exec("UPDATE subscriptions SET status = 'canceled'");
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/book/shop-a1b2c3`), { ...FLAGS_ON, DB: lapsed.DB }, {})).status, 404);
});

test('automated texts and online booking are off unless their Worker vars are "1"', async () => {
  const { DB, put, read } = seedShop({ followups: { reviewRequests: { googleReviewUrl: 'https://g.page/r/abc/review' } } });
  const now = Date.now();
  put('customers', 'Alice Brooks', { name: 'Alice Brooks', phone: '806-555-0101' });
  put('orders', 'RO-1', { customer: 'Alice Brooks', vehicle: '2019 Camry', vin: 'VIN1', status: 'completed', completedAt: new Date(now - 182 * DAY).toISOString(), estimate: { lines: [{ description: 'Oil change' }] } });
  put('invoices', 'INV-1', { number: 'INV-1', customer: 'Alice Brooks', status: 'paid', paidAt: new Date(now - 5 * 3600_000).toISOString() });
  const sent = [];
  const send = async message => { sent.push(message); return {}; };
  for (const value of [undefined, '', '0', 'true']) {
    const env = { DB, AUTOMATED_SMS_ENABLED: value, ONLINE_BOOKING_ENABLED: value };
    const report = await runShopFollowups(env, 'shop-a1b2c3', { now, send, bookingOrigin: ORIGIN });
    assert.equal(report.skippedReason, 'disabled');
    assert.deepEqual(await runScheduledFollowups(env, { now, send }), []);
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/book/shop-a1b2c3`), env, {})).status, 404);
  }
  const waits = [];
  await worker.scheduled({ cron: FOLLOWUP_CRON }, { DB }, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(sent.length, 0);
  assert.deepEqual(read('reminders'), [], 'no reminders are even created');
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM customer_messages').get().n, 0);

  const report = await runShopFollowups({ DB, AUTOMATED_SMS_ENABLED: '1' }, 'shop-a1b2c3', { now, send, bookingOrigin: ORIGIN });
  assert.equal(report.remindersSent, 1);
  assert.doesNotMatch(sent[0].body, /\/api\/book\//, 'no booking link while online booking is off');
});
