import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import {
  billableMinutes,
  meterPhoneCall,
  phoneAllowance,
  phoneBillingPeriod,
  phoneCallDecision,
  phoneUsageSummary,
  splitCallMinutes,
} from '../src/phone-metering.mjs';
import { PUBLIC_PLANS, FOUNDING_PLANS } from '../src/plans.mjs';
import { handleTwilioVoiceIncoming } from '../src/grok-voice.mjs';

const SHOP = 'shop-meter';
const NOW = Date.parse('2026-11-01T15:00:00Z');

function setup({ planId = 'shop', status = 'active', periodStart = '2026-10-20T00:00:00Z', periodEnd = '2026-11-20T00:00:00Z' } = {}) {
  const DB = createD1();
  DB.sqlite.exec('PRAGMA foreign_keys = OFF');
  if (planId) {
    DB.sqlite.prepare('INSERT INTO subscriptions (shop_id, plan_id, status, current_period_start, current_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(SHOP, planId, status, periodStart, periodEnd, '2026-10-20T00:00:00Z');
  }
  return { DB };
}

function addCall(DB, seconds, { at = '2026-10-25T12:00:00Z', userId = 'grok-phone-receptionist', shopId = SHOP } = {}) {
  DB.sqlite.prepare(`INSERT INTO ai_usage_events (id, shop_id, user_id, channel, provider, model, input_tokens, output_tokens, voice_seconds, metadata_json, created_at)
    VALUES (?, ?, ?, 'voice', 'xai', 'grok', 0, 0, ?, '{}', ?)`).run(crypto.randomUUID(), shopId, userId, seconds, at);
}

test('every plan has a minute bucket and overage rate; older plan ids map to the closest bucket', () => {
  for (const plan of [...PUBLIC_PLANS, ...FOUNDING_PLANS]) {
    const allowance = phoneAllowance(plan.id);
    assert.equal(allowance.includedMinutes, plan.aiPhoneMinutes, plan.id);
    assert.equal(allowance.overageRateCents, plan.overageCents, plan.id);
  }
  assert.equal(phoneAllowance('solo').includedMinutes, 200);
  assert.equal(phoneAllowance('shop').includedMinutes, 800);
  assert.equal(phoneAllowance('shop_pro').includedMinutes, 2500);
  assert.equal(phoneAllowance('enterprise').includedMinutes, 10000);
  assert.equal(phoneAllowance('pro').includedMinutes, 2500);
  assert.equal(phoneAllowance('growth').includedMinutes, 800);
  assert.equal(phoneAllowance('unknown-plan').includedMinutes, 200);
});

test('calls round up to whole minutes', () => {
  assert.equal(billableMinutes(0), 0);
  assert.equal(billableMinutes(1), 1);
  assert.equal(billableMinutes(60), 1);
  assert.equal(billableMinutes(61), 2);
});

test('the billing period follows the Stripe period start and rolls forward monthly', () => {
  assert.deepEqual(phoneBillingPeriod({ current_period_start: '2026-10-20T00:00:00Z' }, NOW), { start: '2026-10-20T00:00:00.000Z', end: '2026-11-20T00:00:00.000Z' });
  // A stale anchor (period never refreshed) still counts only the current month of the cycle.
  assert.deepEqual(phoneBillingPeriod({ current_period_start: '2026-07-31T00:00:00Z' }, NOW), { start: '2026-10-31T00:00:00.000Z', end: '2026-11-30T00:00:00.000Z' });
  assert.deepEqual(phoneBillingPeriod(null, NOW), { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' });
});

test('usage counts only AI phone calls in this period for this shop', async () => {
  const { DB } = setup({ planId: 'solo' });
  addCall(DB, 61);                                          // 2 min
  addCall(DB, 30, { userId: 'agentphone-call' });           // 1 min
  addCall(DB, 600, { at: '2026-10-10T00:00:00Z' });          // last period
  addCall(DB, 600, { userId: 'some-staff-user' });           // not a phone call
  addCall(DB, 600, { shopId: 'other-shop' });                // other shop
  const usage = await phoneUsageSummary({ DB }, SHOP, NOW);
  assert.equal(usage.planId, 'solo');
  assert.equal(usage.calls, 2);
  assert.equal(usage.usedMinutes, 3);
  assert.equal(usage.includedMinutes, 200);
  assert.equal(usage.remainingMinutes, 197);
  assert.equal(usage.overageMinutes, 0);
  assert.equal(usage.active, true);
});

test('past the bucket the agent keeps answering and overage is priced at the plan rate', async () => {
  const { DB } = setup({ planId: 'solo' });
  addCall(DB, 205 * 60);
  const decision = await phoneCallDecision({ DB }, SHOP, NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'overage');
  assert.equal(decision.usage.overageMinutes, 5);
  assert.equal(decision.usage.overageChargeCents, 75);
});

test('a finished call splits into included and overage minutes', () => {
  const usage = { usedMinutes: 798, includedMinutes: 800, overageRateCents: 12 };
  assert.deepEqual(splitCallMinutes(usage, 5 * 60), { billableMinutes: 5, includedMinutes: 2, overageMinutes: 3, overageChargeCents: 36 });
  assert.deepEqual(splitCallMinutes({ ...usage, usedMinutes: 10 }, 90), { billableMinutes: 2, includedMinutes: 2, overageMinutes: 0, overageChargeCents: 0 });
  assert.deepEqual(splitCallMinutes({ ...usage, usedMinutes: 900 }, 60), { billableMinutes: 1, includedMinutes: 0, overageMinutes: 1, overageChargeCents: 12 });
});

test('a spending cap stops the AI once overage reaches it; a $0 cap stops at the bucket', async () => {
  const { DB } = setup({ planId: 'solo' });
  addCall(DB, 210 * 60); // 10 min over at 15c = $1.50
  const setCap = cents => DB.sqlite.prepare(`INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, 'shopsettings', 'ai-phone-billing', ?, 'test', 'now', 'now')
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET data_json = excluded.data_json`).run(SHOP, JSON.stringify({ overageCapCents: cents }));
  setCap(500);
  assert.equal((await phoneCallDecision({ DB }, SHOP, NOW)).allowed, true);
  setCap(150);
  const capped = await phoneCallDecision({ DB }, SHOP, NOW);
  assert.equal(capped.allowed, false);
  assert.equal(capped.reason, 'overage_cap_reached');

  const fresh = setup({ planId: 'solo' }).DB;
  addCall(fresh, 200 * 60);
  fresh.sqlite.prepare(`INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, 'shopsettings', 'ai-phone-billing', ?, 'test', 'now', 'now')`).run(SHOP, JSON.stringify({ overageCapCents: 0 }));
  assert.equal((await phoneCallDecision({ DB: fresh }, SHOP, NOW)).allowed, false);
});

test('a shop without an active plan does not get the AI phone agent', async () => {
  assert.equal((await phoneCallDecision({ DB: setup({ planId: null }).DB }, SHOP, NOW)).reason, 'no_active_plan');
  assert.equal((await phoneCallDecision({ DB: setup({ status: 'canceled' }).DB }, SHOP, NOW)).allowed, false);
  assert.equal((await phoneCallDecision({ DB: setup({ status: 'trialing' }).DB }, SHOP, NOW)).allowed, true);
});

test('overage minutes go to the Stripe meter only when one is configured', async () => {
  const { DB } = setup({ planId: 'solo', periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: new Date(Date.now() + 86400000 * 20).toISOString() });
  addCall(DB, 199 * 60, { at: new Date(Date.now() - 3600000).toISOString() });
  DB.sqlite.prepare("INSERT INTO billing_customers (shop_id, stripe_customer_id, created_at) VALUES (?, 'cus_123', 'now')").run(SHOP);
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: String(url), body: String(init.body) }); return new Response('{}', { status: 200 }); };

  const unconfigured = await meterPhoneCall({ DB }, SHOP, { seconds: 180, callId: 'CA1' }, fetcher);
  assert.equal(unconfigured.metering.overageMinutes, 2);
  assert.equal(unconfigured.billedUsd, 0.3);
  assert.equal(unconfigured.metering.stripeReported, false);
  assert.equal(calls.length, 0);

  const env = { DB, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_AI_PHONE_METER_EVENT: 'ai_phone_minutes' };
  const reported = await meterPhoneCall(env, SHOP, { seconds: 180, callId: 'CA2' }, fetcher);
  assert.equal(reported.metering.stripeReported, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/billing/meter_events');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('event_name'), 'ai_phone_minutes');
  assert.equal(body.get('payload[stripe_customer_id]'), 'cus_123');
  assert.equal(body.get('payload[value]'), '2');
  assert.equal(body.get('identifier'), `ai-phone-${SHOP}-CA2`);

  // Inside the bucket: nothing is sent to Stripe.
  const inside = await meterPhoneCall(env, 'shop-no-calls', { seconds: 60, callId: 'CA3' }, fetcher);
  assert.equal(inside.billedUsd, 0);
  assert.equal(calls.length, 1);
});

test('when the AI cannot take a call (no active plan or cap reached), Twilio rings the shop instead', async () => {
  const { DB } = setup({ planId: null });
  DB.sqlite.prepare(`INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, 'shopsettings', 'front_desk_questionnaire', ?, 'test', 'now', 'now')`).run(SHOP, JSON.stringify({ answers: { transferTargets: [{ name: 'Front desk', phone: '+18065550100' }] } }));
  const env = { DB };
  const request = new Request(`https://www.shopcrank.com/api/voice/twilio/incoming/${SHOP}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+18065550199', CallSid: 'CA9' }).toString(),
  });
  const response = await handleTwilioVoiceIncoming(request, env, SHOP, { getSecret: async () => '' });
  const twiml = await response.text();
  assert.match(twiml, /<Dial timeout="25">\+18065550100<\/Dial>/);
  assert.doesNotMatch(twiml, /<Stream/);
});
