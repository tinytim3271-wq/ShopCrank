import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerDocumentLink, handleCustomerDocument } from '../src/customer-documents.mjs';
import { signedRepairOrderForKeys } from '../src/diagnostics.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';
import {
  declinedFollowUpMessage, declinedWorkHtml, declinedWorkItems, declinedWorkSummary,
  ratingForStatus, recordDeclinedFollowUp,
} from '../../src/modules/inspection-ratings.js';

const VIN = '1FTFW1E50NFA00001';
const ORIGIN = 'https://www.shopcrank.com';

function order() {
  return {
    id: 'RO-7', customer: 'Pat Customer', phone: '+18065550101', vehicle: '2022 Ford F-150', vin: VIN,
    estimate: {
      lines: [
        { id: 'brakes', type: 'labor', description: 'Front brake pads', hours: 1.5, laborRate: 150, inspectionStatus: 'critical', photoKeys: ['shops/shop-a/inspection/pads.jpg'], videoKeys: ['shops/shop-a/inspection-video/pads.mp4'] },
        { id: 'wipers', type: 'labor', description: 'Wiper blades', hours: 0.2, laborRate: 150, inspectionStatus: 'soon', photoKeys: ['shops/shop-b/inspection/other-shop.jpg'] },
        { id: 'tires', type: 'labor', description: 'Tire rotation', hours: 0.5, laborRate: 100, inspectionStatus: 'ok' },
      ],
    },
  };
}

async function setup() {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-a', 'orders', 'RO-7', JSON.stringify({ ...order(), createdAt: now, updatedAt: now }), 'u', now, now).runSync();
  const stored = new Map([
    ['shops/shop-a/inspection/pads.jpg', 'image/jpeg'],
    ['shops/shop-a/inspection-video/pads.mp4', 'video/mp4'],
    ['shops/shop-a/inspection/secret.pdf', 'application/pdf'],
    ['shops/shop-b/inspection/other-shop.jpg', 'image/jpeg'],
  ]);
  const env = {
    DB,
    FILES: {
      async get(key) {
        if (!stored.has(key)) return null;
        return { body: `bytes:${key}`, writeHttpMetadata: headers => headers.set('Content-Type', stored.get(key)) };
      },
      async put() {},
    },
  };
  const created = await createCustomerDocumentLink(new Request(`${ORIGIN}/api/document-links`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentType: 'estimate', documentId: 'RO-7' }),
  }), env, { shopId: 'shop-a', userId: 'u1', role: 'service_writer' });
  const { url } = await created.json();
  const token = new URL(url).pathname.split('/').pop();
  const readOrder = () => JSON.parse(DB.sqlite.prepare("SELECT data_json FROM entities WHERE entity_id = 'RO-7'").get().data_json);
  return { env, token, url, readOrder };
}

test('the approval page shows red/yellow/green ratings and the finding photo and video', async () => {
  const { env, token, url } = await setup();
  const response = await handleCustomerDocument(new Request(url), env, token);
  const html = await response.text();
  assert.match(html, /rating-red/);
  assert.match(html, /1 need attention now/);
  assert.match(html, /1 need attention soon/);
  assert.match(html, /1 look good/);
  assert.match(html, /<img[^>]+media\?key=shops%2Fshop-a%2Finspection%2Fpads\.jpg/);
  assert.match(html, /<video[^>]+media\?key=shops%2Fshop-a%2Finspection-video%2Fpads\.mp4/);
  assert.doesNotMatch(html, /other-shop\.jpg/, 'media from another shop is never linked');
  assert.match(html, /id="tap-approve"/);
  assert.match(response.headers.get('Content-Security-Policy'), /media-src 'self'/);
});

test('customer media is limited to files referenced by this document in this shop', async () => {
  const { env, token } = await setup();
  const media = key => handleCustomerDocument(new Request(`${ORIGIN}/api/customer-documents/${token}/media?key=${encodeURIComponent(key)}`), env, token, 'media');
  const video = await media('shops/shop-a/inspection-video/pads.mp4');
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('Content-Type'), 'video/mp4');
  assert.match(video.headers.get('Content-Security-Policy'), /sandbox/);
  for (const key of ['shops/shop-a/inspection/secret.pdf', 'shops/shop-b/inspection/other-shop.jpg', '../x']) {
    await assert.rejects(() => media(key), error => error.status === 404, key);
  }
});

test('one-tap approval records the typed name, keeps declined lines, and never counts as a signature', async () => {
  const { env, token, url, readOrder } = await setup();
  const response = await handleCustomerDocument(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'tap', authorizationName: 'Pat Customer', decisions: { brakes: 'approved', wipers: 'declined', tires: 'approved' } }),
  }), env, token);
  assert.equal(response.status, 200);
  const saved = readOrder();
  assert.equal(saved.estimateApproval.status, 'approved');
  assert.equal(saved.estimateApproval.type, 'online');
  assert.equal(saved.estimateApproval.signatureKey, undefined);
  assert.ok(saved.linesLockedAt);
  assert.equal(saved.estimate.lines.find(line => line.id === 'wipers').approvalStatus, 'declined');
  assert.equal(await signedRepairOrderForKeys(env.DB, 'shop-a', 'RO-7', VIN), null, 'one-tap approval cannot authorize live key work');

  const items = declinedWorkItems([saved], { now: Date.now() + 31 * 86400000 });
  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Wiper blades');
  assert.equal(items[0].rating, 'yellow');
  assert.equal(items[0].amount, 30);
  assert.equal(items[0].due, true);
});

test('declined work tracking: red findings come due in 3 days, follow-ups and sales are recorded', () => {
  const declinedAt = '2026-10-01T12:00:00.000Z';
  const base = { ...order(), estimateApproval: { status: 'declined', respondedAt: declinedAt, decisions: { brakes: 'declined', wipers: 'declined', tires: 'declined' } } };
  const now = Date.parse('2026-10-05T00:00:00.000Z');
  const items = declinedWorkItems([base], { now });
  const brakes = items.find(item => item.lineId === 'brakes');
  assert.equal(brakes.rating, 'red');
  assert.equal(brakes.dueAt, '2026-10-04T12:00:00.000Z');
  assert.equal(brakes.due, true);
  assert.equal(items.find(item => item.lineId === 'wipers').due, false);
  assert.match(declinedFollowUpMessage(brakes, 'Lubbock Brake & Tire'), /Hi Pat, this is Lubbock Brake & Tire\. .*Front brake pads on your 2022 Ford F-150\. Our technician flagged it/);

  const contacted = recordDeclinedFollowUp(base, 'brakes', { contacted: true, by: 'u1', at: '2026-10-05T01:00:00.000Z' });
  const sold = recordDeclinedFollowUp(contacted, 'brakes', { sold: true, at: '2026-10-06T00:00:00.000Z' });
  const after = declinedWorkItems([sold], { now });
  assert.equal(after.find(item => item.lineId === 'brakes').status, 'sold');
  assert.equal(declinedWorkSummary(after).openCount, 2);
  const html = declinedWorkHtml(after);
  assert.match(html, /Declined work/);
  assert.match(html, /data-declined-text="RO-7:wipers"/);
  assert.doesNotMatch(html, /data-declined-text="RO-7:brakes"/);
});

test('DVI statuses map onto red/yellow/green', () => {
  assert.equal(ratingForStatus('critical'), 'red');
  assert.equal(ratingForStatus('monitor'), 'yellow');
  assert.equal(ratingForStatus('soon'), 'yellow');
  assert.equal(ratingForStatus('ok'), 'green');
  assert.equal(ratingForStatus('skipped'), null);
});
