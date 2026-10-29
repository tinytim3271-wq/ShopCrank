import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FOUNDING_MEMBER_CAP,
  FOUNDING_PLANS,
  LIVE_DIAGNOSTICS_PLANS,
  PUBLIC_PLANS,
  PUBLIC_TRIAL_DAYS,
  claimDecision,
  dollars,
  hasPlanCapability,
  isPlaceholderPrice,
  planCapabilities,
  stripePriceForPlan,
} from '../src/plans.mjs';

const migration = readFileSync(new URL('../migrations/0004_launch_plans.sql', import.meta.url), 'utf8');
const pricing = readFileSync(new URL('../../public/pricing/index.html', import.meta.url), 'utf8');
const founding = readFileSync(new URL('../../public/founding/index.html', import.meta.url), 'utf8');

test('public trial length is fourteen days', () => {
  assert.equal(PUBLIC_TRIAL_DAYS, 14);
});

test('public prices are the locked launch catalog and match the pricing page', () => {
  assert.deepEqual(PUBLIC_PLANS.map(plan => [plan.id, plan.monthlyPriceCents, plan.aiPhoneMinutes, plan.diagnosticsMode]), [
    ['solo', 6900, 200, 'simulate'],
    ['shop', 13900, 800, 'simulate'],
    ['shop_pro', 27900, 2500, 'live'],
    ['enterprise', 55900, 10000, 'live'],
  ]);
  for (const plan of PUBLIC_PLANS) {
    assert.equal(plan.annualPriceCents, plan.monthlyPriceCents * 10);
    assert.match(pricing, new RegExp(dollars(plan.monthlyPriceCents).replace('$', '\\$')));
    assert.match(migration, new RegExp(`'${plan.id}'`));
  }
  assert.doesNotMatch(pricing, /\$49|\$99\/mo|Founding Member/);
  assert.match(pricing, /Unlimited users/);
  assert.match(pricing, /2 months free/);
});

test('founding prices stay off the public page and on the invite page', () => {
  assert.equal(FOUNDING_MEMBER_CAP, 50);
  assert.deepEqual(FOUNDING_PLANS.map(plan => plan.monthlyPriceCents), [4900, 9900, 19900]);
  assert.match(founding, /\$49/);
  assert.match(founding, /\$99/);
  assert.match(founding, /\$199/);
  assert.match(founding, /invite/);
  assert.match(founding, new RegExp(`first ${FOUNDING_MEMBER_CAP}`));
  assert.equal(LIVE_DIAGNOSTICS_PLANS.has('shop'), false);
  assert.equal(LIVE_DIAGNOSTICS_PLANS.has('shop_pro'), true);
  assert.equal(LIVE_DIAGNOSTICS_PLANS.has('founding_pro'), true);
});

test('placeholder Stripe prices are not sent to Checkout', () => {
  assert.equal(isPlaceholderPrice('price_shop_pro'), true);
  assert.equal(isPlaceholderPrice('price_1ABC123xyz'), false);
  assert.equal(stripePriceForPlan({}, 'shop'), '');
  assert.equal(stripePriceForPlan({ STRIPE_PRICE_SHOP_MONTHLY: 'price_1ABC123xyz' }, 'shop'), 'price_1ABC123xyz');
  assert.equal(stripePriceForPlan({ STRIPE_PRICE_SHOP_ANNUAL: 'price_9annual' }, 'shop', 'annual'), 'price_9annual');
  assert.equal(stripePriceForPlan({ STRIPE_PRICE_SHOP_MONTHLY: 'price_shop' }, 'shop'), '');
});

test('plan capabilities gate paid integrations; texting is on every plan', () => {
  for (const plan of ['solo', 'shop', 'shop_pro', 'enterprise', 'founding_solo', 'founding_shop', 'founding_pro']) {
    assert.equal(planCapabilities(plan).includes('sms'), true, plan);
  }
  assert.equal(planCapabilities('solo').includes('quickbooks'), false);
  assert.deepEqual(planCapabilities('shop').includes('sms'), true);
  assert.deepEqual(planCapabilities('shop_pro').includes('live_diagnostics'), true);
  assert.deepEqual(planCapabilities('unknown'), []);
});

test('expired and invalid subscription periods do not grant plan capabilities', () => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  assert.equal(hasPlanCapability({ plan_id: 'shop', status: 'trialing', current_period_end: '2026-10-08T00:00:00.000Z' }, 'sms', now), false);
  assert.equal(hasPlanCapability({ plan_id: 'shop', status: 'trialing', current_period_end: 'invalid' }, 'sms', now), false);
  assert.equal(hasPlanCapability({ plan_id: 'shop', status: 'active', current_period_end: '2026-10-10T00:00:00.000Z' }, 'sms', now), true);
  assert.equal(hasPlanCapability({ plan_id: 'solo', status: 'active' }, 'sms', now), true);
  assert.equal(hasPlanCapability({ plan_id: 'solo', status: 'canceled' }, 'sms', now), false);
});

test('a founding claim fails closed when the invite is missing, used, or the cap is full', () => {
  assert.equal(claimDecision({ invite: null, counter: { claimed: 0, cap: 50 }, planId: 'founding_shop' }).status, 404);
  assert.equal(claimDecision({ invite: { used_at: '2026-09-30' }, counter: { claimed: 1, cap: 50 }, planId: 'founding_shop' }).status, 409);
  assert.equal(claimDecision({ invite: { token: 'abc' }, counter: { claimed: 50, cap: 50 }, planId: 'founding_shop' }).status, 409);
  assert.equal(claimDecision({ invite: { token: 'abc' }, counter: { claimed: 38, cap: 50 }, planId: 'shop' }).status, 400);
  const ok = claimDecision({ invite: { token: 'abc' }, counter: { claimed: 38, cap: 50 }, planId: 'founding_shop' });
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 11);
});
