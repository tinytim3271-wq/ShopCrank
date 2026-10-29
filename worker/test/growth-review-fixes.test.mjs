import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { dueReminders, plannedServiceReminders, followupSettings, runShopFollowups, supersededReminders, vehicleIdentity } from '../src/customer-followups.mjs';
import { availableSlots, bookAppointment, parseShopHours } from '../src/scheduling.mjs';
import { createCustomerDocumentLink, handleCustomerDocument } from '../src/customer-documents.mjs';
import { isVideoMedia } from '../../src/modules/inspection-ratings.js';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { FLAGS_ON } from './helpers/growth-flags-on.mjs';

const ORIGIN = 'https://www.shopcrank.com';
const DAY = 86400000;

function shop({ status = 'active', periodEnd = null, suspended = false, booking = {} } = {}) {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.sqlite.exec(`
    INSERT INTO shops (id, name, slug, timezone, created_at, updated_at) VALUES ('shop-r3v13w', 'Review Garage', 'shop-r3v13w', 'America/Chicago', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, current_period_end, updated_at) VALUES ('shop-r3v13w', 'solo', '${status}', ${periodEnd ? `'${periodEnd}'` : 'NULL'}, '${now}');
  `);
  if (suspended) DB.sqlite.exec(`INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, created_at, updated_at, created_by, suspended) VALUES ('shop-r3v13w', 'Review Garage', 'o@x.test', 'O', '${now}', '${now}', 't', 1)`);
  const put = (type, id, data) => DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-r3v13w', type, id, JSON.stringify({ id, ...data }), 'u', now, now).runSync();
  put('shopsettings', 'booking', { hours: 'Monday-Sunday 7:00 AM - 7:00 PM', leadMinutes: 0, capacity: 1, ...booking });
  put('shopsettings', 'followups', { reviewRequests: { googleReviewUrl: 'https://g.page/r/abc/review' } });
  const read = type => DB.sqlite.prepare('SELECT data_json FROM entities WHERE entity_type = ?').all(type).map(row => JSON.parse(row.data_json));
  return { DB, put, read };
}

function seedDue({ put }) {
  const now = Date.now();
  put('customers', 'Alice', { name: 'Alice', phone: '806-555-0101' });
  put('orders', 'RO-1', { customer: 'Alice', vehicle: 'Camry', vin: '4T1B11HK5KU123456', status: 'completed', completedAt: new Date(now - 182 * DAY).toISOString(), estimate: { lines: [{ description: 'Oil change' }] } });
  put('invoices', 'INV-1', { number: 'INV-1', customer: 'Alice', status: 'paid', paidAt: new Date(now - 5 * 3600_000).toISOString() });
}

const sender = sent => async message => { sent.push(message); return { provider: 'twilio', messageSid: `SM${sent.length}`, status: 'queued' }; };

test('follow-ups and booking stop for expired trials and suspended shops', async () => {
  for (const options of [{ status: 'trialing', periodEnd: new Date(Date.now() - DAY).toISOString() }, { suspended: true }]) {
    const fixture = shop(options);
    seedDue(fixture);
    const sent = [];
    const report = await runShopFollowups({ ...FLAGS_ON, DB: fixture.DB }, 'shop-r3v13w', { send: sender(sent) });
    assert.equal(report.skippedReason, 'not_entitled');
    assert.equal(sent.length, 0);
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/book/shop-r3v13w`), { ...FLAGS_ON, DB: fixture.DB }, {})).status, 404);
  }
});

test('one run per shop at a time; records are claimed before texting', async () => {
  const fixture = shop();
  seedDue(fixture);
  const sent = [];
  const [first, second] = await Promise.all([
    runShopFollowups({ ...FLAGS_ON, DB: fixture.DB }, 'shop-r3v13w', { send: sender(sent) }),
    runShopFollowups({ ...FLAGS_ON, DB: fixture.DB }, 'shop-r3v13w', { send: sender(sent) }),
  ]);
  assert.equal([first, second].filter(report => report.skippedReason === 'already_running').length, 1);
  assert.equal(sent.length, 2, 'one reminder and one review request, once');
});

test('nothing is texted when opt-outs cannot be read; reviews pause when history cannot be read', async () => {
  const fixture = shop();
  seedDue(fixture);
  const DB = {
    ...fixture.DB,
    prepare: sql => (/FROM sms_consent/.test(sql) ? { bind: () => ({ all: async () => { throw new Error('D1 down'); } }) } : fixture.DB.prepare(sql)),
    batch: fixture.DB.batch,
  };
  const sent = [];
  const report = await runShopFollowups({ ...FLAGS_ON, DB }, 'shop-r3v13w', { send: sender(sent) });
  assert.equal(sent.length, 0);
  assert.match(report.errors.join(' '), /opt-out list unavailable/);

  const second = shop();
  seedDue(second);
  const DB2 = { ...second.DB, prepare: sql => (/message_type = 'review_request' GROUP BY/.test(sql) ? { bind: () => ({ all: async () => { throw new Error('D1 down'); } }) } : second.DB.prepare(sql)), batch: second.DB.batch };
  const sent2 = [];
  const report2 = await runShopFollowups({ ...FLAGS_ON, DB: DB2 }, 'shop-r3v13w', { send: sender(sent2) });
  assert.equal(report2.reviewRequestsSent, 0);
  assert.equal(report2.remindersSent, 1, 'reminders still go out');
});

test('reminders come from performed work, use real vehicle identity, skip email reminders, and supersede older ones', () => {
  const settings = followupSettings();
  const orders = [
    { id: 'RO-1', customer: 'A', vehicle: 'Civic', vin: 'VIN pending', status: 'completed', completedAt: '2026-01-10', complaint: 'brakes grinding', estimate: { lines: [{ description: 'Oil change' }, { description: 'Front brake pads', approvalStatus: 'declined' }] } },
    { id: 'RO-2', customer: 'B', vehicle: 'Civic', vin: 'VIN pending', status: 'completed', completedAt: '2026-02-10', estimate: { lines: [{ description: 'Oil change' }] } },
  ];
  const planned = plannedServiceReminders(orders, [], settings);
  assert.deepEqual(planned.map(item => item.service).sort(), ['Oil change', 'Oil change'], 'complaint and declined brakes are not service history');
  assert.notEqual(vehicleIdentity(orders[0]), vehicleIdentity(orders[1]), 'placeholder VINs never merge two customers');
  const reminders = [
    { id: 'old', source: 'auto', seriesKey: 'k', lastServiceDate: '2026-01-10', dueDate: '2026-07-10' },
    { id: 'new', source: 'auto', seriesKey: 'k', lastServiceDate: '2026-06-10', dueDate: '2026-12-10' },
    { id: 'email', dueDate: '2026-07-01', channel: 'email' },
    { id: 'sms', dueDate: '2026-07-01' },
  ];
  assert.deepEqual(supersededReminders(reminders).map(item => item.id), ['old']);
  assert.deepEqual(dueReminders(reminders, { today: '2026-07-08' }).map(item => item.id), ['sms']);
});

test('booking: the last slot cannot be double-booked, and minimum notice spans days', async () => {
  const { DB } = shop();
  const date = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const attempt = phone => bookAppointment({ DB }, 'shop-r3v13w', { customerName: `C${phone}`, phone, vehicle: 'Civic', service: 'Oil', date, time: '09:00' }).then(() => 'ok', error => error.status);
  const outcomes = await Promise.all([attempt('806-555-0111'), attempt('806-555-0112'), attempt('806-555-0113')]);
  assert.equal(outcomes.filter(item => item === 'ok').length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every(item => item === 'ok' || item === 409));
  const hours = parseShopHours('Monday-Sunday 8:00 AM - 5:00 PM');
  const now = { date: '2026-11-02', minutes: 17 * 60 };
  assert.ok(!availableSlots({ date: '2026-11-03', hours, now, config: { leadMinutes: 1440 } }).includes('08:00'), '24 h notice at 5 PM hides tomorrow morning');
  assert.deepEqual(availableSlots({ date: '2026-11-04', hours, now, config: { leadMinutes: 1440 } })[0], '08:00');
});

test('booking confirmation respects STOP and is logged when sent', async () => {
  const { DB } = shop();
  DB.sqlite.exec("INSERT INTO sms_consent (shop_id, phone, status, source, updated_at) VALUES ('shop-r3v13w', '+18065550150', 'opted_out', 'test', 'now')");
  const slots = await (await worker.fetch(new Request(`${ORIGIN}/api/book/shop-r3v13w/slots`), { ...FLAGS_ON, DB }, {})).json();
  const env = { ...FLAGS_ON, DB, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+18065550000' };
  const realFetch = globalThis.fetch;
  let twilioCalls = 0;
  globalThis.fetch = async (url, init) => (String(url).includes('api.twilio.com') ? (twilioCalls += 1, Response.json({ sid: 'SM1', status: 'queued' })) : realFetch(url, init));
  try {
    const book = (phone, time) => worker.fetch(new Request(`${ORIGIN}/api/book/shop-r3v13w`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: 'X', phone, vehicle: 'Civic', service: 'Oil', date: slots.days[0].date, time }) }), env, {});
    assert.equal((await book('806-555-0150', slots.days[0].slots[0])).status, 201);
    assert.equal(twilioCalls, 0, 'opted-out number gets no confirmation');
    assert.equal((await book('806-555-0151', slots.days[0].slots[1])).status, 201);
    assert.equal(twilioCalls, 1);
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_messages WHERE message_type = 'booking_confirmation'").get().n, 1);
    const smsOff = { ...env, AUTOMATED_SMS_ENABLED: '0' };
    const quiet = await worker.fetch(new Request(`${ORIGIN}/api/book/shop-r3v13w`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: 'Y', phone: '806-555-0152', vehicle: 'Civic', service: 'Oil', date: slots.days.at(-1).date, time: slots.days.at(-1).slots.at(-1) }) }), smsOff, {});
    assert.equal(quiet.status, 201, 'booking still works with automated texts off');
    assert.equal(twilioCalls, 1, 'but no confirmation text goes out');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('uploaded inspection videos are recognized, and inspection-wide media reaches the approval page', async () => {
  assert.equal(isVideoMedia('shops/shop-a/inspection-video/0b6f1c2e-uuid'), true);
  assert.equal(isVideoMedia('shops/shop-a/inspection/0b6f1c2e-uuid'), false);
  const { DB } = shop();
  const now = new Date().toISOString();
  DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-r3v13w', 'orders', 'RO-9', JSON.stringify({ id: 'RO-9', estimate: { photoKeys: ['shops/shop-r3v13w/inspection-video/abc'], lines: [{ id: 'l1', type: 'labor', description: 'Pads', hours: 1, laborRate: 100 }] } }), 'u', now, now).runSync();
  const env = { DB, FILES: { async get() { return { body: 'v', writeHttpMetadata: headers => headers.set('Content-Type', 'video/mp4') }; } } };
  const created = await (await createCustomerDocumentLink(new Request(`${ORIGIN}/api/document-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentType: 'estimate', documentId: 'RO-9' }) }), env, { shopId: 'shop-r3v13w', userId: 'u', role: 'admin' })).json();
  const token = new URL(created.url).pathname.split('/').pop();
  const html = await (await handleCustomerDocument(new Request(created.url), env, token)).text();
  assert.match(html, /Inspection photos and video/);
  assert.match(html, /<video[^>]+inspection-video%2Fabc/);
  const media = await handleCustomerDocument(new Request(`${ORIGIN}/api/customer-documents/${token}/media?key=${encodeURIComponent('shops/shop-r3v13w/inspection-video/abc')}`), env, token, 'media');
  assert.equal(media.status, 200);
});

test('review fixes: same-name callers never overwrite each other; sends only touch the follow-up fields', async () => {
  const fixture = shop({ booking: { capacity: 5 } });
  fixture.put('customers', 'Alice Brooks', { name: 'Alice Brooks', phone: '806-555-0101' });
  const date = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const a = await bookAppointment({ DB: fixture.DB }, 'shop-r3v13w', { customerName: 'Alice Brooks', phone: '806-555-0177', vehicle: 'Civic', service: 'Oil', date, time: '09:00' });
  const b = await bookAppointment({ DB: fixture.DB }, 'shop-r3v13w', { customerName: 'Alice Brooks', phone: '912-555-0177', vehicle: 'F-150', service: 'Oil', date, time: '10:00' });
  assert.deepEqual([a.customer.name, b.customer.name], ['Alice Brooks (0177)', 'Alice Brooks (0177-2)']);
  const phones = fixture.read('customers').map(customer => customer.phone).sort();
  assert.deepEqual(phones, ['806-555-0101', '806-555-0177', '912-555-0177']);

  const second = shop();
  seedDue(second);
  const report = await runShopFollowups({ ...FLAGS_ON, DB: second.DB }, 'shop-r3v13w', {
    send: async message => {
      // Staff collect a signature on the invoice while the text is in flight.
      second.DB.sqlite.prepare("UPDATE entities SET data_json = json_set(data_json, '$.signature', 'signed') WHERE entity_id = 'INV-1'").run();
      return { provider: 'twilio', messageSid: message.to, status: 'queued' };
    },
  });
  assert.equal(report.reviewRequestsSent, 1);
  const invoice = second.read('invoices')[0];
  assert.equal(invoice.signature, 'signed');
  assert.ok(invoice.reviewRequestedAt);
});

test('review fixes: attention is yellow, shop-scoped photo keys print, new callers are named, and no dead booking links', async () => {
  const { ratingForStatus } = await import('../../src/modules/inspection-ratings.js');
  const { inspectionPhotoSrc } = await import('../../src/modules/shop-inspections.js');
  const { buildCallSummary, callActionFromTool } = await import('../src/call-summaries.mjs');
  assert.equal(ratingForStatus('attention'), 'yellow');
  assert.equal(inspectionPhotoSrc('shops/shop-a/inspection-video/abc-123', '/api'), '/api/files/object?key=shops%2Fshop-a%2Finspection-video%2Fabc-123');
  assert.equal(inspectionPhotoSrc('shops/shop-a/../x', '/api'), '');
  const record = await buildCallSummary({}, { shopId: 's', transcript: [{ role: 'caller', text: 'I need an oil change' }], actions: [callActionFromTool('book_appointment', {}, { booked: true, appointmentId: 'a1', date: '2026-11-03', time: '09:00', service: 'Oil', customerName: 'Pat New' })] });
  assert.equal(record.customer, 'Pat New');

  const fixture = shop({ booking: { enabled: false } });
  seedDue(fixture);
  const sent = [];
  await runShopFollowups({ ...FLAGS_ON, DB: fixture.DB }, 'shop-r3v13w', { send: sender(sent), bookingOrigin: ORIGIN });
  const reminder = sent.find(message => /is due/.test(message.body));
  assert.ok(reminder);
  assert.doesNotMatch(reminder.body, /\/api\/book\//);
  assert.match(reminder.body, /Reply to this text to schedule/);
});
