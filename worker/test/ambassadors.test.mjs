import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { AMBASSADOR_PAYOUT_CRON, assembleReport, payoutReportHtml, payoutReportPdf } from '../src/ambassadors/payout-report.mjs';
import { generateCommissionLedger, periodBounds, periodOf, previousPeriod, shiftPeriod } from '../src/ambassadors/commissions.mjs';
import { applyAttribution, normalizeReferralCode, randomReferralCode } from '../src/ambassadors/store.mjs';
import { provisionShopRoles } from '../src/onboarding/roles.mjs';
import { buildPdf } from '../src/ambassadors/pdf.mjs';

const ADMIN = 'owner@shopcrank.com';
const ORIGIN = 'https://www.shopcrank.com';
const WEBHOOK_SECRET = 'whsec_ambassador_test_secret';
const LAST_MONTH = previousPeriod(new Date());
const IN_LAST_MONTH = new Date(Date.parse(periodBounds(LAST_MONTH).start) + 3 * 86400000).toISOString();

function setup(extraEnv = {}) {
  const DB = createD1();
  const sent = [];
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    ACCESS_ADMIN_EMAILS: ADMIN,
    AUTH_EXPOSE_LOGIN_LINK: '1',
    STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SUPPORT_EMAIL_TO: 'support@shopcrank.com',
    AUTH_EMAIL_FROM: 'noreply@shopcrank.com',
    EMAIL: { send: async message => { sent.push(message); } },
    ...extraEnv,
  };
  const call = async (method, path, body, { email = ADMIN, headers = {}, raw = false } = {}) => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.20',
        ...(email ? { 'X-ShopCrank-Dev-Email': email } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    }), env, {});
    if (raw) return response;
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* html */ }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { env, DB, call, sent };
}

async function signedWebhook(env, event) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  const signature = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await worker.fetch(new Request(`${ORIGIN}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
    body: payload,
  }), env, {});
  return { status: response.status, body: await response.json() };
}

async function createAmbassador(call, body = {}) {
  const result = await call('POST', '/admin/ambassadors', {
    name: 'Jane Rivera', email: `jane${Math.random().toString(36).slice(2, 7)}@example.test`, phone: '806-555-0101',
    territory: 'Texas Panhandle', mailingAddress: '12 Main St\nAmarillo, TX 79101', ...body,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.ambassador;
}

async function createShop(call, shopId, body = {}) {
  const result = await call('POST', '/admin/accounts', {
    shopName: `${shopId} Auto`, shopId, ownerName: 'Owner', email: `${shopId}@shops.test`, accountMode: 'active', planId: 'shop', ...body,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

/** A Stripe invoice line for the licensed membership price covering `start`. */
function membershipLine(start, amount, extra = {}) {
  return { type: 'subscription', amount, period: { start, end: start + 30 * 86400 }, price: { recurring: { interval: 'month', usage_type: 'licensed' } }, ...extra };
}

function subscription(DB, shopId) {
  return DB.sqlite.prepare('SELECT * FROM subscriptions WHERE shop_id = ?').get(shopId);
}

function backdateSale(DB, shopId, when = IN_LAST_MONTH) {
  DB.sqlite.prepare('UPDATE subscriptions SET attributed_at = ? WHERE shop_id = ?').run(when, shopId);
  const { start, end } = periodBounds(periodOf(when));
  DB.sqlite.prepare(`
    INSERT OR REPLACE INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at)
    VALUES (?, ?, ?, 'test', ?)
  `).run(shopId, start, end, new Date().toISOString());
}

async function magicLinkSignup(call, body, headers = {}) {
  const requested = await call('POST', '/auth/magic-link', { returnTo: '/app', ...body }, { email: null, headers });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const token = new URL(requested.body.loginUrl).searchParams.get('token');
  const confirmed = await call('POST', '/auth/callback', `token=${token}`, {
    email: null,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
  });
  assert.equal(confirmed.status, 302);
}

function shopIdForEmail(DB, email) {
  return DB.sqlite.prepare('SELECT shop_id FROM users WHERE email = ?').get(email).shop_id;
}

test('ambassador numbers and referral codes are unique and sequential', async () => {
  const { call } = setup();
  const first = await createAmbassador(call);
  const second = await createAmbassador(call, { name: 'Marco Diaz' });
  assert.equal(first.ambassadorNumber, 'AMB-0001');
  assert.equal(second.ambassadorNumber, 'AMB-0002');
  assert.match(first.referralCode, /^[A-Z2-9]{6}$/);
  assert.notEqual(first.referralCode, second.referralCode);
  assert.equal(first.status, 'approved');

  const custom = await createAmbassador(call, { name: 'Custom', referralCode: 'tex-as1' });
  assert.equal(custom.referralCode, 'TEXAS1');
  const duplicate = await call('POST', '/admin/ambassadors', { name: 'Dupe', email: 'dupe@example.test', referralCode: 'TEXAS1' });
  assert.equal(duplicate.status, 409);

  const updated = await call('PUT', `/admin/ambassadors/${first.id}`, { status: 'suspended', payoutDetails: 'Check to Jane Rivera' });
  assert.equal(updated.body.ambassador.status, 'suspended');
  assert.equal(updated.body.ambassador.payoutDetails, 'Check to Jane Rivera');
  assert.equal((await call('PUT', `/admin/ambassadors/${first.id}`, { status: 'retired' })).status, 400);

  const list = await call('GET', '/admin/ambassadors');
  assert.deepEqual(list.body.ambassadors.map(item => item.ambassadorNumber), ['AMB-0001', 'AMB-0002', 'AMB-0003']);
  assert.equal((await call('DELETE', `/admin/ambassadors/${custom.id}`)).body.deleted, true);

  assert.equal(normalizeReferralCode(' ab-12 '), 'AB12');
  assert.equal(normalizeReferralCode('x'), '');
  assert.doesNotMatch(randomReferralCode(40), /[01OIL]/);
});

test('only the platform owner can reach the ambassador admin office', async () => {
  const { call, DB } = setup();
  const now = new Date().toISOString();
  DB.sqlite.prepare("INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES ('boss@shop.test', 'shop-a', 'admin', 'Boss', ?, ?)").run(now, now);
  for (const path of ['/admin/ambassadors', '/admin/ambassador-sales', '/admin/ambassador-commission-rates', '/admin/ambassador-payout-reports']) {
    assert.equal((await call('GET', path, undefined, { email: 'boss@shop.test' })).status, 403, path);
  }
});

test('applications create an applied ambassador that earns no credit until approved', async () => {
  const { call, DB } = setup();
  const applied = await call('POST', '/ambassadors/apply', {
    name: 'Ava Stone', email: 'Ava@Example.test', phone: '555-0100', experience: '10 years selling shop software',
    why: 'I know every shop in town', territory: 'Lubbock, TX', socialReach: 'Facebook group 4k members',
  }, { email: null });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'applied');
  const row = DB.sqlite.prepare('SELECT * FROM ambassadors WHERE email = ?').get('ava@example.test');
  assert.equal(row.status, 'applied');
  const application = JSON.parse(row.application_json);
  assert.equal(application.socialReach, 'Facebook group 4k members');
  assert.equal(application.experience, '10 years selling shop software');
  assert.equal((await call('POST', '/ambassadors/apply', { name: 'Ava', email: 'ava@example.test', why: 'x', territory: 'y' }, { email: null })).status, 409);
  assert.equal((await call('POST', '/ambassadors/apply', { name: 'No why', email: 'nowhy@example.test' }, { email: null })).status, 400);

  assert.equal((await call('GET', `/ambassadors/validate?code=${row.referral_code}`, undefined, { email: null })).body.valid, false);
  await magicLinkSignup(call, { email: 'early@shop.test', shopName: 'Early Auto', referralCode: row.referral_code });
  assert.equal(subscription(DB, shopIdForEmail(DB, 'early@shop.test')).sold_by_ambassador_id, null, 'applied ambassadors are not credited');

  await call('PUT', `/admin/ambassadors/${row.id}`, { status: 'approved' });
  const valid = await call('GET', `/ambassadors/validate?code=${row.referral_code.toLowerCase()}`, undefined, { email: null });
  assert.deepEqual(valid.body, { valid: true, code: row.referral_code, name: 'Ava' });
});

test('every creation path records sold_by and sale_source', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);

  // Manual admin entry, with and without an ambassador.
  await createShop(call, 'manual-credit', { soldByAmbassadorId: amb.id, saleSource: 'ambassador_referral' });
  let sub = subscription(DB, 'manual-credit');
  assert.equal(sub.sold_by_ambassador_id, amb.id);
  assert.equal(sub.sale_source, 'ambassador_referral');
  assert.equal(sub.sold_by, `AMB-0001 · ${amb.name}`);
  await createShop(call, 'manual-none');
  sub = subscription(DB, 'manual-none');
  assert.equal(sub.sale_source, 'admin_manual');
  assert.equal(sub.sold_by_ambassador_id, null);
  assert.equal((await call('POST', '/admin/accounts', { shopName: 'Bad', shopId: 'bad-amb', ownerName: 'O', email: 'o@bad.test', soldByAmbassadorId: 'missing' })).status, 400);

  // Self-signup with email: ?ref= link (site), typed code (referral), cookie, and none.
  await magicLinkSignup(call, { email: 'site@shop.test', shopName: 'Site Auto', referralCode: amb.referralCode, referralSource: 'ambassador_site' });
  sub = subscription(DB, shopIdForEmail(DB, 'site@shop.test'));
  assert.equal(sub.sold_by_ambassador_id, amb.id);
  assert.equal(sub.sale_source, 'ambassador_site');
  assert.equal(sub.referral_code, amb.referralCode);

  await magicLinkSignup(call, { email: 'typed@shop.test', shopName: 'Typed Auto', referralCode: amb.referralCode.toLowerCase(), referralSource: 'ambassador_referral' });
  assert.equal(subscription(DB, shopIdForEmail(DB, 'typed@shop.test')).sale_source, 'ambassador_referral');

  await magicLinkSignup(call, { email: 'cookie@shop.test', shopName: 'Cookie Auto' }, { Cookie: `sc_ref=${amb.referralCode}; sc_ref_src=ambassador_site` });
  assert.equal(subscription(DB, shopIdForEmail(DB, 'cookie@shop.test')).sold_by_ambassador_id, amb.id);

  await magicLinkSignup(call, { email: 'direct@shop.test', shopName: 'Direct Auto', referralSource: 'admin_manual' });
  sub = subscription(DB, shopIdForEmail(DB, 'direct@shop.test'));
  assert.equal(sub.sale_source, 'shopcrank_online', 'self-serve callers cannot pick admin sources');
  assert.equal(sub.sold_by, 'ShopCrank online');

  // AI onboarding agent.
  await provisionShopRoles(env, {
    shopId: 'agent-shop', dbaName: 'Agent Auto', planId: 'shop_pro', referralCode: amb.referralCode,
    contact: { firstName: 'Al', lastName: 'Agent', email: 'al@agent.test' }, staff: [],
  }, { actor: 'onboarding-agent' });
  sub = subscription(DB, 'agent-shop');
  assert.equal(sub.sold_by_ambassador_id, amb.id);
  assert.equal(sub.sale_source, 'ai_agent');
  await provisionShopRoles(env, {
    shopId: 'agent-direct', dbaName: 'Agent Direct', contact: { firstName: 'B', lastName: 'C', email: 'b@agent.test' }, staff: [],
  });
  assert.equal(subscription(DB, 'agent-direct').sale_source, 'ai_agent');

  const log = DB.sqlite.prepare('SELECT * FROM ambassador_attribution_log').all();
  assert.ok(log.length >= 8);
  assert.ok(log.every(row => row.changed_by && row.created_at));
});

test('invalid subscription attribution does not change membership', async () => {
  const { call, DB } = setup();
  await createShop(call, 'invalid-subscription-credit');
  const before = {
    account: DB.sqlite.prepare('SELECT * FROM accounts WHERE shop_id = ?').get('invalid-subscription-credit'),
    shop: DB.sqlite.prepare('SELECT * FROM shops WHERE id = ?').get('invalid-subscription-credit'),
    subscription: subscription(DB, 'invalid-subscription-credit'),
  };

  const result = await call('POST', '/admin/accounts/invalid-subscription-credit/subscription', {
    mode: 'trialing',
    trialDays: 30,
    soldByAmbassadorId: 'missing',
  });

  assert.equal(result.status, 400);
  assert.deepEqual({
    account: DB.sqlite.prepare('SELECT * FROM accounts WHERE shop_id = ?').get('invalid-subscription-credit'),
    shop: DB.sqlite.prepare('SELECT * FROM shops WHERE id = ?').get('invalid-subscription-credit'),
    subscription: subscription(DB, 'invalid-subscription-credit'),
  }, before);
});

test('only one concurrent first-credit attribution wins and is audited', async () => {
  const { call, DB, env } = setup();
  const jane = await createAmbassador(call);
  const marco = await createAmbassador(call, { name: 'Marco Diaz' });
  await createShop(call, 'race-credit');

  const results = await Promise.all([
    applyAttribution(env, 'race-credit', {
      ambassador: jane, saleSource: 'ambassador_referral', onlyIfUncredited: true,
    }),
    applyAttribution(env, 'race-credit', {
      ambassador: marco, saleSource: 'ambassador_site', onlyIfUncredited: true,
    }),
  ]);
  const sub = subscription(DB, 'race-credit');
  const credits = DB.sqlite.prepare(`
    SELECT * FROM ambassador_attribution_log
    WHERE shop_id = ? AND new_ambassador_id IS NOT NULL
  `).all('race-credit');

  assert.equal(results.filter(result => result.changed).length, 1);
  assert.ok([jane.id, marco.id].includes(sub.sold_by_ambassador_id));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].new_ambassador_id, sub.sold_by_ambassador_id);
});

test('Stripe checkout carries the referral into metadata and the webhook credits the sale', async () => {
  const { call, DB, env } = setup({ STRIPE_SECRET_KEY: 'sk_test_ambassador', STRIPE_PRICE_SHOP_MONTHLY: 'price_1ShopMonthlyLive' });
  const amb = await createAmbassador(call);
  const now = new Date().toISOString();
  DB.sqlite.exec(`
    INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, created_at, updated_at, created_by) VALUES ('stripe-shop', 'Stripe Auto', 'pay@shop.test', 'Pat', '${now}', '${now}', 'test');
    INSERT INTO shops (id, name, slug, created_at, updated_at) VALUES ('stripe-shop', 'Stripe Auto', 'stripe-shop', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('stripe-shop', 'shop', 'trialing', '${now}');
    INSERT INTO billing_customers (shop_id, stripe_customer_id, created_at) VALUES ('stripe-shop', 'cus_123', '${now}');
    INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES ('pay@shop.test', 'stripe-shop', 'admin', 'Pat', '${now}', '${now}');
  `);
  const originalFetch = globalThis.fetch;
  let checkoutBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v1/checkout/sessions')) {
      checkoutBody = new URLSearchParams(String(init.body));
      return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    }
    return originalFetch(url, init);
  };
  try {
    const checkout = await call('POST', '/billing/checkout', { planId: 'shop', referralCode: amb.referralCode, referralSource: 'ambassador_referral' }, { email: 'pay@shop.test' });
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(checkoutBody.get('metadata[ambassadorId]'), amb.id);
  assert.equal(checkoutBody.get('subscription_data[metadata][ambassadorId]'), amb.id);
  assert.equal(checkoutBody.get('metadata[saleSource]'), 'ambassador_referral');

  const completed = await signedWebhook(env, {
    id: 'evt_checkout_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', client_reference_id: 'stripe-shop', customer: 'cus_123', subscription: 'sub_1', metadata: { shopId: 'stripe-shop', planId: 'shop', ambassadorId: amb.id, saleSource: 'ambassador_referral' } } },
  });
  assert.equal(completed.status, 202);
  let sub = subscription(DB, 'stripe-shop');
  assert.equal(sub.sold_by_ambassador_id, amb.id);
  assert.equal(sub.sale_source, 'ambassador_referral');
  assert.equal(sub.status, 'active');

  // A later checkout with someone else's code never steals existing credit.
  const other = await createAmbassador(call, { name: 'Other' });
  await signedWebhook(env, {
    id: 'evt_checkout_2', type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', client_reference_id: 'stripe-shop', customer: 'cus_123', metadata: { shopId: 'stripe-shop', planId: 'shop', ambassadorId: other.id, saleSource: 'ambassador_site' } } },
  });
  sub = subscription(DB, 'stripe-shop');
  assert.equal(sub.sold_by_ambassador_id, amb.id);

  // A plain online checkout with no referral is recorded as shopcrank_online.
  DB.sqlite.exec(`
    INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, created_at, updated_at, created_by) VALUES ('online-shop', 'Online Auto', 'o@shop.test', 'O', '${now}', '${now}', 'test');
    INSERT INTO shops (id, name, slug, created_at, updated_at) VALUES ('online-shop', 'Online Auto', 'online-shop', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('online-shop', 'solo', 'trialing', '${now}');
  `);
  await signedWebhook(env, {
    id: 'evt_checkout_3', type: 'checkout.session.completed',
    data: { object: { id: 'cs_3', client_reference_id: 'online-shop', metadata: { shopId: 'online-shop', planId: 'solo', saleSource: 'shopcrank_online' } } },
  });
  assert.equal(subscription(DB, 'online-shop').sale_source, 'shopcrank_online');
});

test('invoice.paid accrues one commission per shop per month and skips $0 and uncredited invoices', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'inv-shop', { soldByAmbassadorId: amb.id, planId: 'shop_pro' });
  await createShop(call, 'inv-direct', { planId: 'shop' });
  const periodStart = Math.floor(Date.parse(`${periodOf(new Date())}-01T00:00:00Z`) / 1000) + 86400;
  const servicePeriod = shiftPeriod(periodOf(new Date()), -4);
  const servicePeriodStart = Math.floor(Date.parse(periodBounds(servicePeriod).start) / 1000) + 86400;
  const invoice = (id, extra = {}) => ({
    id,
    type: 'invoice.paid',
    data: { object: {
      id: `in_${id}`, metadata: { shopId: 'inv-shop' }, amount_paid: 27900, period_start: periodStart,
      lines: { data: [membershipLine(servicePeriodStart, 27900)] },
      ...extra,
    } },
  });

  await signedWebhook(env, invoice('evt_inv_1'));
  await signedWebhook(env, invoice('evt_inv_1'));
  await signedWebhook(env, invoice('evt_inv_2'));
  await signedWebhook(env, invoice('evt_inv_zero', { amount_paid: 0, metadata: { shopId: 'inv-shop' }, period_start: periodStart + 40 * 86400 }));
  await signedWebhook(env, { id: 'evt_inv_direct', type: 'invoice.paid', data: { object: { id: 'in_d', metadata: { shopId: 'inv-direct' }, amount_paid: 13900, period_start: periodStart, lines: { data: [membershipLine(periodStart, 13900)] } } } });
  const lines = DB.sqlite.prepare('SELECT * FROM ambassador_commissions').all();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].shop_id, 'inv-shop');
  assert.equal(lines[0].amount_cents, 4000);
  assert.equal(lines[0].tier, 'shop_pro');
  assert.equal(lines[0].accrued_via, 'invoice_paid');
  assert.equal(lines[0].period, servicePeriod);
  assert.equal(lines[0].earning_period, servicePeriod);
});

test('invoice.paid recovers payment-failed memberships and skips canceled or suspended shops', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  for (const shopId of ['recovered-shop', 'canceled-invoice-shop', 'suspended-invoice-shop']) {
    await createShop(call, shopId, { soldByAmbassadorId: amb.id });
    DB.sqlite.prepare('UPDATE subscriptions SET stripe_subscription_id = ? WHERE shop_id = ?').run(`sub-${shopId}`, shopId);
  }
  DB.sqlite.prepare("UPDATE subscriptions SET status = 'past_due' WHERE shop_id = 'recovered-shop'").run();
  DB.sqlite.prepare("UPDATE accounts SET subscription_status = 'past_due' WHERE shop_id = 'recovered-shop'").run();
  DB.sqlite.prepare("UPDATE shops SET billing_status = 'past_due' WHERE id = 'recovered-shop'").run();
  DB.sqlite.prepare("UPDATE subscriptions SET status = 'canceled' WHERE shop_id = 'canceled-invoice-shop'").run();
  DB.sqlite.prepare("UPDATE accounts SET suspended = 1 WHERE shop_id = 'suspended-invoice-shop'").run();

  const periodStart = Math.floor(Date.now() / 1000);
  for (const shopId of ['recovered-shop', 'canceled-invoice-shop', 'suspended-invoice-shop']) {
    await signedWebhook(env, {
      id: `evt_${shopId}`,
      type: 'invoice.paid',
      data: { object: {
        id: `in_${shopId}`,
        subscription: `sub-${shopId}`,
        metadata: { shopId },
        amount_paid: 2000,
        period_start: periodStart,
        lines: { data: [membershipLine(periodStart, 2000)] },
      } },
    });
  }

  assert.equal(subscription(DB, 'recovered-shop').status, 'active');
  assert.equal(DB.sqlite.prepare('SELECT subscription_status FROM accounts WHERE shop_id = ?').get('recovered-shop').subscription_status, 'active');
  assert.equal(DB.sqlite.prepare('SELECT billing_status FROM shops WHERE id = ?').get('recovered-shop').billing_status, 'active');
  assert.deepEqual(
    DB.sqlite.prepare('SELECT shop_id FROM ambassador_commissions ORDER BY shop_id').all().map(row => row.shop_id),
    ['recovered-shop'],
  );
});

test('monthly ledger pays only active, paid memberships of approved ambassadors', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  const suspendedAmb = await createAmbassador(call, { name: 'Suspended Sam' });
  const cases = [
    ['active-solo', 'solo', 'active', true],
    ['active-ent', 'enterprise', 'active', true],
    ['trial-shop', 'shop', 'trialing', false],
    ['pastdue-shop', 'shop', 'past_due', false],
    ['cancel-shop', 'shop', 'canceled', false],
    ['suspended-acct', 'shop', 'active', false],
  ];
  for (const [shopId, planId] of cases) await createShop(call, shopId, { planId, soldByAmbassadorId: amb.id });
  for (const [shopId, , status] of cases) {
    DB.sqlite.prepare('UPDATE subscriptions SET status = ? WHERE shop_id = ?').run(status, shopId);
    backdateSale(DB, shopId);
  }
  DB.sqlite.prepare("UPDATE accounts SET suspended = 1 WHERE shop_id = 'suspended-acct'").run();
  await createShop(call, 'amb-suspended', { soldByAmbassadorId: suspendedAmb.id });
  backdateSale(DB, 'amb-suspended');
  await call('PUT', `/admin/ambassadors/${suspendedAmb.id}`, { status: 'suspended' });
  await createShop(call, 'sold-this-month', { soldByAmbassadorId: amb.id });

  const first = await generateCommissionLedger(env, LAST_MONTH);
  assert.equal(first.created, 2);
  const again = await generateCommissionLedger(env, LAST_MONTH);
  assert.equal(again.created, 0, 'idempotent');
  const lines = DB.sqlite.prepare('SELECT shop_id, amount_cents FROM ambassador_commissions ORDER BY shop_id').all();
  assert.deepEqual(lines.map(line => [line.shop_id, line.amount_cents]), [['active-ent', 10000], ['active-solo', 1000]]);

  const open = await call('POST', '/admin/ambassador-commissions/generate', { period: periodOf(new Date()) });
  assert.equal(open.status, 400, 'the current month is still open');
});

test('a late trial-to-paid conversion does not earn for an unpaid month', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'late-conversion', { accountMode: 'trialing', soldByAmbassadorId: amb.id });
  await createShop(call, 'stripe-late-conversion', { accountMode: 'trialing', soldByAmbassadorId: amb.id });
  DB.sqlite.prepare('UPDATE subscriptions SET attributed_at = ? WHERE shop_id = ?').run(IN_LAST_MONTH, 'late-conversion');
  DB.sqlite.prepare('UPDATE subscriptions SET attributed_at = ? WHERE shop_id = ?').run(IN_LAST_MONTH, 'stripe-late-conversion');

  const activated = await call('POST', '/admin/accounts/late-conversion/subscription', { mode: 'active' });
  assert.equal(activated.status, 200);
  const coverage = DB.sqlite.prepare('SELECT starts_at FROM ambassador_paid_coverage WHERE shop_id = ?').get('late-conversion');
  assert.ok(coverage.starts_at >= periodBounds(LAST_MONTH).end);

  const paidEffectiveAt = Math.floor(Date.parse(periodBounds(shiftPeriod(LAST_MONTH, 1)).start) / 1000);
  const periodStart = Math.floor(Date.parse(periodBounds(LAST_MONTH).start) / 1000);
  const periodEnd = Math.floor(Date.parse(periodBounds(shiftPeriod(shiftPeriod(LAST_MONTH, 1), 1)).start) / 1000);
  await signedWebhook(env, {
    id: 'evt_trial_paid_effective',
    type: 'customer.subscription.updated',
    data: { object: {
      id: 'sub-stripe-late',
      status: 'active',
      current_period_start: periodStart,
      current_period_end: periodEnd,
      trial_end: paidEffectiveAt,
      metadata: { shopId: 'stripe-late-conversion', planId: 'shop' },
    } },
  });
  const stripeCoverage = DB.sqlite.prepare('SELECT starts_at FROM ambassador_paid_coverage WHERE shop_id = ?').get('stripe-late-conversion');
  assert.equal(stripeCoverage, undefined, 'subscription status alone never records paid coverage');
  assert.equal((await generateCommissionLedger(env, LAST_MONTH)).created, 0);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_commissions WHERE shop_id IN ('late-conversion', 'stripe-late-conversion')").get().n, 0);
});

test('commission rates are configurable and drive new accruals', async () => {
  const { call, DB } = setup();
  const rates = await call('GET', '/admin/ambassador-commission-rates');
  const byPlan = Object.fromEntries(rates.body.rates.map(rate => [rate.planId, rate.monthlyCents]));
  assert.deepEqual([byPlan.solo, byPlan.shop, byPlan.shop_pro, byPlan.enterprise], [1000, 2000, 4000, 10000]);
  assert.equal(byPlan.founding_shop, 2000);
  const updated = await call('PUT', '/admin/ambassador-commission-rates', { rates: [{ planId: 'shop', monthlyCents: 2500 }] });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.rates.find(rate => rate.planId === 'shop').updatedBy, ADMIN);
  assert.equal((await call('PUT', '/admin/ambassador-commission-rates', { rates: [{ planId: 'shop', monthlyCents: -1 }] })).status, 400);

  const amb = await createAmbassador(call);
  await createShop(call, 'rate-shop', { soldByAmbassadorId: amb.id });
  backdateSale(DB, 'rate-shop');
  const generated = await call('POST', '/admin/ambassador-commissions/generate', { period: LAST_MONTH });
  assert.equal(generated.body.created, 1);
  const ledger = await call('GET', `/admin/ambassador-commissions?period=${LAST_MONTH}`);
  assert.equal(ledger.body.lines[0].amountCents, 2500);
  assert.equal(ledger.body.totals.pendingCents, 2500);
});

test('payout closing redirects invoice accruals and completes the frozen month ledger', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'closing-shop', { soldByAmbassadorId: amb.id });
  await createShop(call, 'ledger-shop', { soldByAmbassadorId: amb.id });
  backdateSale(DB, 'closing-shop');
  backdateSale(DB, 'ledger-shop');
  DB.sqlite.prepare('INSERT INTO ambassador_payout_period_closures (period, status, closed_at) VALUES (?, ?, ?)').run(LAST_MONTH, 'closing', new Date().toISOString());

  assert.equal((await generateCommissionLedger(env, LAST_MONTH)).frozen, true);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM ambassador_commissions').get().n, 0);

  const periodStart = Math.floor(Date.parse(periodBounds(LAST_MONTH).start) / 1000) + 3600;
  await signedWebhook(env, {
    id: 'evt_closing',
    type: 'invoice.paid',
    data: { object: { id: 'in_closing', metadata: { shopId: 'closing-shop' }, amount_paid: 2000, period_start: periodStart, lines: { data: [membershipLine(periodStart, 2000)] } } },
  });
  assert.equal(DB.sqlite.prepare('SELECT period FROM ambassador_commissions WHERE shop_id = ?').get('closing-shop').period, shiftPeriod(LAST_MONTH, 1));

  const report = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  assert.equal(report.body.report.totals.grandTotalCents, 2000);
  assert.equal(DB.sqlite.prepare('SELECT period FROM ambassador_commissions WHERE shop_id = ?').get('ledger-shop').period, LAST_MONTH);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM ambassador_commissions WHERE shop_id = ?').get('closing-shop').n, 1);
});

test('sales view filters and audited credit reassignment', async () => {
  const { call, DB } = setup();
  const amb = await createAmbassador(call);
  const other = await createAmbassador(call, { name: 'Other Olsen' });
  await createShop(call, 'sale-a', { soldByAmbassadorId: amb.id, saleSource: 'ambassador_site' });
  await createShop(call, 'sale-b');
  DB.sqlite.prepare("UPDATE subscriptions SET attributed_at = '2025-01-15T00:00:00.000Z' WHERE shop_id = 'sale-b'").run();

  assert.deepEqual((await call('GET', `/admin/ambassador-sales?ambassadorId=${amb.id}`)).body.sales.map(sale => sale.shopId), ['sale-a']);
  assert.deepEqual((await call('GET', '/admin/ambassador-sales?ambassadorId=none')).body.sales.map(sale => sale.shopId), ['sale-b']);
  assert.deepEqual((await call('GET', '/admin/ambassador-sales?source=admin_manual')).body.sales.map(sale => sale.shopId), ['sale-b']);
  assert.deepEqual((await call('GET', '/admin/ambassador-sales?from=2025-01-01&to=2025-01-31')).body.sales.map(sale => sale.shopId), ['sale-b']);
  const all = await call('GET', '/admin/ambassador-sales');
  const saleA = all.body.sales.find(sale => sale.shopId === 'sale-a');
  assert.equal(saleA.planId, 'shop');
  assert.equal(saleA.status, 'active');
  assert.equal(saleA.ambassadorNumber, 'AMB-0001');
  assert.equal((await call('GET', '/admin/ambassador-sales?source=bogus')).status, 400);

  assert.equal((await call('POST', '/admin/ambassador-sales/sale-a/attribution', { ambassadorId: other.id, saleSource: 'ambassador_referral' })).status, 400, 'reason required');
  const moved = await call('POST', '/admin/ambassador-sales/sale-a/attribution', { ambassadorId: other.id, saleSource: 'ambassador_referral', reason: 'Other did the demo' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.sale.ambassadorId, other.id);
  assert.equal(moved.body.log[0].previousAmbassadorNumber, 'AMB-0001');
  assert.equal(moved.body.log[0].newAmbassadorNumber, 'AMB-0002');
  assert.equal(moved.body.log[0].changedBy, ADMIN);
  assert.equal(moved.body.log[0].reason, 'Other did the demo');

  const removed = await call('POST', '/admin/ambassador-sales/sale-a/attribution', { ambassadorId: null, saleSource: 'shopcrank_online', reason: 'Self-serve after all' });
  assert.equal(removed.body.sale.ambassadorId, '');
  assert.equal((await call('GET', '/admin/ambassador-sales/sale-a/log')).body.log.length, 3);
  assert.equal((await call('DELETE', `/admin/ambassadors/${amb.id}`)).status, 409, 'history blocks deletion');
});

test('payout report: tiers, sources, frozen snapshot, mark paid, print and PDF', async () => {
  const { call, DB, env } = setup();
  const jane = await createAmbassador(call, { name: 'Jane Rivera' });
  const marco = await createAmbassador(call, { name: 'Marco Diaz', mailingAddress: '9 Elm\nCanyon, TX 79015' });
  const sales = [
    ['j-solo', 'solo', jane, 'ambassador_site'],
    ['j-shop1', 'shop', jane, 'ambassador_site'],
    ['j-shop2', 'shop', jane, 'ambassador_referral'],
    ['j-pro', 'shop_pro', jane, 'shopcrank_online'],
    ['j-found', 'founding_shop', jane, 'ambassador_referral'],
    ['m-ent', 'enterprise', marco, 'ambassador_referral'],
  ];
  for (const [shopId, planId, amb, saleSource] of sales) {
    await createShop(call, shopId, { planId, soldByAmbassadorId: amb.id, saleSource });
    backdateSale(DB, shopId);
  }
  const generated = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH });
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const report = generated.body.report;
  assert.equal(report.totals.ambassadorCount, 2);
  const j = report.ambassadors.find(item => item.ambassadorNumber === 'AMB-0001');
  assert.equal(j.referralCode, jane.referralCode);
  assert.deepEqual(['solo', 'shop', 'shop_pro', 'enterprise'].map(tier => j.tiers[tier].count), [1, 3, 1, 0]);
  assert.deepEqual(['solo', 'shop', 'shop_pro', 'enterprise'].map(tier => j.tiers[tier].rateCents), [1000, 2000, 4000, null]);
  assert.equal(j.tiers.shop.subtotalCents, 6000);
  assert.equal(j.totalCents, 1000 + 6000 + 4000);
  assert.deepEqual(['shopcrank_online', 'ambassador_site', 'ambassador_referral'].map(source => j.sources[source].count), [1, 2, 2]);
  assert.equal(j.sources.ambassador_site.amountCents, 3000);
  assert.equal(report.totals.grandTotalCents, 11000 + 10000);
  assert.equal(report.totals.tiers.enterprise.subtotalCents, 10000);

  // Frozen: rate changes and re-generation leave the snapshot alone.
  await call('PUT', '/admin/ambassador-commission-rates', { rates: [{ planId: 'enterprise', monthlyCents: 99900 }] });
  const regenerated = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.created, false);
  assert.equal(regenerated.body.report.totals.grandTotalCents, 21000);
  assert.equal((await generateCommissionLedger(env, LAST_MONTH)).frozen, true);

  // Late invoice.paid for the frozen month lands in the next open month.
  await createShop(call, 'late-shop', { planId: 'solo', soldByAmbassadorId: marco.id });
  const lastMonthStart = Math.floor(Date.parse(periodBounds(LAST_MONTH).start) / 1000) + 3600;
  await signedWebhook(env, { id: 'evt_late', type: 'invoice.paid', data: { object: { id: 'in_late', metadata: { shopId: 'late-shop' }, amount_paid: 6900, period_start: lastMonthStart, lines: { data: [membershipLine(lastMonthStart, 6900)] } } } });
  assert.equal(DB.sqlite.prepare("SELECT period FROM ambassador_commissions WHERE shop_id = 'late-shop'").get().period, shiftPeriod(LAST_MONTH, 1));
  await signedWebhook(env, { id: 'evt_late_duplicate', type: 'invoice.paid', data: { object: { id: 'in_late_duplicate', metadata: { shopId: 'late-shop' }, amount_paid: 6900, period_start: lastMonthStart, lines: { data: [membershipLine(lastMonthStart, 6900)] } } } });
  backdateSale(DB, 'late-shop');
  await generateCommissionLedger(env, shiftPeriod(LAST_MONTH, 1));
  const lateShopLines = DB.sqlite.prepare("SELECT period, earning_period FROM ambassador_commissions WHERE shop_id = 'late-shop' ORDER BY earning_period").all()
    .map(line => [line.period, line.earning_period]);
  assert.deepEqual(lateShopLines, [
    [shiftPeriod(LAST_MONTH, 1), LAST_MONTH],
    [shiftPeriod(LAST_MONTH, 1), shiftPeriod(LAST_MONTH, 1)],
  ]);

  // Mark paid.
  assert.equal((await call('POST', `/admin/ambassador-payout-reports/${LAST_MONTH}/payouts/${jane.id}`, { checkNumber: '', paidOn: '2026-11-03' })).status, 400);
  assert.equal((await call('POST', `/admin/ambassador-payout-reports/${LAST_MONTH}/payouts/${jane.id}`, { checkNumber: '1001', paidOn: '11/03/2026' })).status, 400);
  const paid = await call('POST', `/admin/ambassador-payout-reports/${LAST_MONTH}/payouts/${jane.id}`, { checkNumber: '1001', paidOn: '2026-11-03' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.payout.amountCents, 11000);
  const view = await call('GET', `/admin/ambassador-payout-reports/${LAST_MONTH}`);
  assert.equal(view.body.ambassadors.find(item => item.ambassadorId === jane.id).payout.checkNumber, '1001');
  assert.equal(view.body.ambassadors.find(item => item.ambassadorId === marco.id).payout, null);
  assert.equal(view.body.paidCents, 11000);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_commissions WHERE ambassador_id = ? AND status = 'paid'").get(jane.id).n, 5);
  const list = await call('GET', '/admin/ambassador-payout-reports');
  assert.equal(list.body.schedule, AMBASSADOR_PAYOUT_CRON);
  assert.equal(list.body.reports[0].paidCount, 1);

  const print = await call('GET', `/admin/ambassador-payout-reports/${LAST_MONTH}/print`);
  assert.match(print.headers.get('Content-Type'), /text\/html/);
  assert.equal((print.body.match(/<section class="page">/g) || []).length, 3, 'summary + one page per ambassador');
  assert.match(print.body, /Canyon, TX 79015/);
  assert.match(print.body, /Check 1001/);
  assert.match(print.body, /Grand total: <b>\$210\.00<\/b>/);

  const pdf = await call('GET', `/admin/ambassador-payout-reports/${LAST_MONTH}/pdf`, undefined, { raw: true });
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
  assert.ok(bytes.startsWith('%PDF-1.4'));
  assert.ok(bytes.trimEnd().endsWith('%%EOF'));
  assert.equal((bytes.match(/\/Type \/Page /g) || []).length, 3);
  assert.match(bytes, /\(Total due: \$110\.00\)/);

  assert.equal((await call('GET', '/admin/ambassador-payout-reports/2020-01')).status, 404);
  assert.equal((await call('POST', '/admin/ambassador-payout-reports', { period: periodOf(new Date()) })).status, 400);
});

test('the monthly cron freezes last month and emails the admin once', async () => {
  const { call, DB, env, sent } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'cron-shop', { planId: 'shop', soldByAmbassadorId: amb.id });
  backdateSale(DB, 'cron-shop');
  const send = env.EMAIL.send;
  env.EMAIL.send = async () => { throw new Error('temporary email outage'); };
  await worker.scheduled({ cron: AMBASSADOR_PAYOUT_CRON }, env, {});
  let row = DB.sqlite.prepare('SELECT * FROM ambassador_payout_reports WHERE period = ?').get(LAST_MONTH);
  assert.equal(row.grand_total_cents, 2000);
  assert.equal(row.generated_by, 'cron');
  assert.match(row.email_status, /^send_failed:/);
  assert.equal(sent.length, 0);

  env.EMAIL.send = send;
  await worker.scheduled({ cron: AMBASSADOR_PAYOUT_CRON }, env, {});
  row = DB.sqlite.prepare('SELECT * FROM ambassador_payout_reports WHERE period = ?').get(LAST_MONTH);
  assert.equal(row.email_status, 'sent:support@shopcrank.com');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\$20\.00/);
  assert.match(sent[0].text, new RegExp(`${amb.referralCode}`));
  await worker.scheduled({ cron: AMBASSADOR_PAYOUT_CRON }, env, {});
  assert.equal(sent.length, 1, 'no second email for an existing snapshot');

  const noEmail = setup({ EMAIL: undefined });
  await worker.scheduled({ cron: AMBASSADOR_PAYOUT_CRON }, noEmail.env, {});
  assert.equal(noEmail.DB.sqlite.prepare('SELECT email_status FROM ambassador_payout_reports').get().email_status, 'email_not_configured');
});

test('admin can retry a payout report notification without recreating the snapshot', async () => {
  const { call, env, sent } = setup();
  let fail = true;
  let attempts = 0;
  env.EMAIL.send = async message => {
    attempts += 1;
    if (fail) throw new Error('temporary email outage');
    sent.push(message);
  };

  const first = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH, notify: true });
  assert.equal(first.status, 201);
  assert.match(first.body.email, /^send_failed:/);

  fail = false;
  const retry = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH, notify: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.email, 'sent:support@shopcrank.com');
  assert.equal(retry.body.report.emailStatus, 'sent:support@shopcrank.com');

  const alreadySent = await call('POST', '/admin/ambassador-payout-reports', { period: LAST_MONTH, notify: true });
  assert.equal(alreadySent.status, 200);
  assert.equal(alreadySent.body.email, null);
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
});

test('statements: admin view and ambassador self-service by code and email', async () => {
  const { call, DB } = setup();
  const amb = await createAmbassador(call, { email: 'jane@amb.test' });
  await createShop(call, 'stmt-shop', { planId: 'enterprise', soldByAmbassadorId: amb.id });
  backdateSale(DB, 'stmt-shop');
  await call('POST', '/admin/ambassador-commissions/generate', { period: LAST_MONTH });
  const admin = await call('GET', `/admin/ambassadors/${amb.id}/statement`);
  assert.equal(admin.body.totals.earnedCents, 10000);
  assert.equal(admin.body.lines[0].shopName, 'stmt-shop Auto');
  const detail = await call('GET', `/admin/ambassadors/${amb.id}`);
  assert.equal(detail.body.sales.length, 1);

  const self = await call('POST', '/ambassadors/statement', { code: amb.referralCode.toLowerCase(), email: 'JANE@amb.test' }, { email: null });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.equal(self.body.totals.pendingCents, 10000);
  assert.equal(self.body.lines[0].period, LAST_MONTH);
  assert.equal(self.body.ambassador.email, undefined);
  assert.equal((await call('POST', '/ambassadors/statement', { code: amb.referralCode, email: 'someone@else.test' }, { email: null })).status, 404);
});

test('commission totals include all matching rows while ledger results are paginated', async () => {
  const { call, DB } = setup();
  const amb = await createAmbassador(call, { email: 'pages@amb.test' });
  const insert = DB.sqlite.prepare(`
    INSERT INTO ambassador_commissions
      (id, ambassador_id, shop_id, period, earning_period, plan_id, tier, amount_cents, status, accrued_via, created_at)
    VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 100, ?, 'manual', ?)
  `);
  const now = new Date().toISOString();
  for (let index = 0; index < 2001; index += 1) {
    insert.run(`commission-${index}`, amb.id, `commission-shop-${String(index).padStart(4, '0')}`, LAST_MONTH, LAST_MONTH, index === 2000 ? 'paid' : 'pending', now);
  }

  const firstPage = await call('GET', `/admin/ambassador-commissions?period=${LAST_MONTH}&ambassadorId=${amb.id}`);
  assert.equal(firstPage.body.lines.length, 200);
  assert.deepEqual(firstPage.body.pagination, { page: 1, pageSize: 200, totalLines: 2001, pageCount: 11 });
  assert.deepEqual(firstPage.body.totals, { earnedCents: 200100, paidCents: 100, pendingCents: 200000, lines: 2001 });

  const lastPage = await call('GET', `/admin/ambassador-commissions?period=${LAST_MONTH}&ambassadorId=${amb.id}&page=11`);
  assert.equal(lastPage.body.lines.length, 1);
  assert.equal(lastPage.body.lines[0].status, 'paid');
  assert.equal(lastPage.body.totals.earnedCents, 200100);

  const statement = await call('GET', `/admin/ambassadors/${amb.id}/statement?page=11`);
  assert.equal(statement.body.lines.length, 1);
  assert.equal(statement.body.pagination.totalLines, 2001);
  assert.equal(statement.body.totals.lines, 2001);
  assert.equal(statement.body.totals.earnedCents, 200100);

  const self = await call('POST', '/ambassadors/statement', { code: amb.referralCode, email: amb.email, page: 11 }, { email: null });
  assert.equal(self.body.lines.length, 1);
  assert.equal(self.body.pagination.page, 11);
  assert.equal(self.body.totals.earnedCents, 200100);
});

test('report assembly and PDF writer handle empty months and long statements', () => {
  const empty = assembleReport({ period: '2026-01', lines: [], ambassadors: new Map(), generatedAt: '2026-02-01T09:00:00.000Z', generatedBy: 'cron' });
  assert.equal(empty.totals.grandTotalCents, 0);
  assert.equal(empty.periodLabel, 'January 2026');
  const many = Array.from({ length: 120 }, (_, index) => ({ text: `Line ${index} (with parens) \\ and ünïcode` }));
  const { bytes, pageCount } = buildPdf([[{ text: 'Summary' }], many]);
  assert.equal(pageCount, 4, 'a long statement continues onto extra pages');
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\(Line 7 \\\(with parens\\\) \\\\ and \?n\?code\) Tj/);
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(xref).startsWith('xref'), 'startxref points at the xref table');
});

test('payout rate breakdowns use accrued amounts and label mixed rates', () => {
  const report = assembleReport({
    period: '2026-01',
    lines: [
      { id: 'c1', ambassador_id: 'a1', shop_id: 's1', shop_name: 'Shop One', tier: 'shop', amount_cents: 2000 },
      { id: 'c2', ambassador_id: 'a1', shop_id: 's2', shop_name: 'Shop Two', tier: 'shop', amount_cents: 2500 },
    ],
    ambassadors: new Map([['a1', { ambassador_number: 'AMB-0001', name: 'Jane' }]]),
    generatedAt: '2026-02-01T09:00:00.000Z',
    generatedBy: 'cron',
  });
  const tier = report.totals.tiers.shop;
  assert.equal(tier.rateCents, null);
  assert.deepEqual(tier.rateBreakdown, [
    { rateCents: 2000, count: 1, subtotalCents: 2000 },
    { rateCents: 2500, count: 1, subtotalCents: 2500 },
  ]);
  assert.equal(tier.subtotalCents, 4500);
  assert.match(payoutReportHtml(report), /Mixed \(\$20\.00, \$25\.00\)/);
  const pdf = Buffer.from(payoutReportPdf(report).bytes).toString('latin1');
  assert.match(pdf, /mixed/);
  assert.match(pdf, /1 x \$20\.00/);
  assert.match(pdf, /1 x \$25\.00/);
});

test('coverage backfill falls back to updated_at for admin-created active memberships', () => {
  const before = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql') && name < '0023').sort();
  const DB = createD1(before);
  DB.sqlite.prepare("INSERT INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at) VALUES ('legacy-admin', 'Legacy', 'legacy-admin', 'America/Chicago', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  DB.sqlite.prepare("INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('legacy-admin', 'shop', 'active', '2026-02-03T04:05:06.000Z')").run();
  DB.sqlite.exec(readFileSync(new URL('../migrations/0023_ambassador_paid_coverage.sql', import.meta.url), 'utf8'));
  const row = DB.sqlite.prepare("SELECT starts_at, ends_at FROM ambassador_paid_coverage WHERE shop_id = 'legacy-admin'").get();
  assert.deepEqual({ ...row }, { starts_at: '2026-02-03T04:05:06.000Z', ends_at: null });
});

test('only a paid membership line records coverage; metered usage and full discounts do not', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'line-shop', { soldByAmbassadorId: amb.id });
  await createShop(call, 'discount-shop', { soldByAmbassadorId: amb.id });
  for (const shopId of ['line-shop', 'discount-shop']) DB.sqlite.prepare('DELETE FROM ambassador_paid_coverage WHERE shop_id = ?').run(shopId);
  const usageStart = Math.floor(Date.parse(periodBounds(shiftPeriod(periodOf(new Date()), -3)).start) / 1000) + 3600;
  const membershipStart = Math.floor(Date.parse(periodBounds(shiftPeriod(periodOf(new Date()), -2)).start) / 1000) + 3600;
  const usage = membershipLine(usageStart, 400, { price: { recurring: { interval: 'month', usage_type: 'metered' } } });

  await signedWebhook(env, { id: 'evt_usage_first', type: 'invoice.paid', data: { object: {
    id: 'in_usage_first', metadata: { shopId: 'line-shop' }, amount_paid: 14300,
    lines: { data: [usage, membershipLine(membershipStart, 13900)] },
  } } });
  const line = DB.sqlite.prepare("SELECT earning_period FROM ambassador_commissions WHERE shop_id = 'line-shop'").get();
  assert.equal(line.earning_period, shiftPeriod(periodOf(new Date()), -2), 'the membership line, not the usage line, sets the month');
  assert.equal(DB.sqlite.prepare("SELECT starts_at FROM ambassador_paid_coverage WHERE shop_id = 'line-shop'").get().starts_at, new Date(membershipStart * 1000).toISOString());

  await signedWebhook(env, { id: 'evt_discounted', type: 'invoice.paid', data: { object: {
    id: 'in_discounted', metadata: { shopId: 'discount-shop' }, amount_paid: 400,
    lines: { data: [membershipLine(membershipStart, 13900, { discount_amounts: [{ amount: 13900 }] }), usage] },
  } } });
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_paid_coverage WHERE shop_id = 'discount-shop'").get().n, 0);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_commissions WHERE shop_id = 'discount-shop'").get().n, 0);

  await signedWebhook(env, { id: 'evt_checkout_trial', type: 'checkout.session.completed', data: { object: {
    id: 'cs_trial', subscription: 'sub_trial', metadata: { shopId: 'discount-shop', planId: 'shop' },
  } } });
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_paid_coverage WHERE shop_id = 'discount-shop'").get().n, 0, 'checkout alone is not paid coverage');
});

test('suspension ends coverage for good; restoring brings none back until a new payment or activation', async () => {
  const { call, DB, env } = setup();
  const amb = await createAmbassador(call);
  await createShop(call, 'cut-shop', { soldByAmbassadorId: amb.id });
  DB.sqlite.prepare('DELETE FROM ambassador_paid_coverage WHERE shop_id = ?').run('cut-shop');
  const past = new Date(Date.now() - 10 * 86400000).toISOString();
  const soon = new Date(Date.now() + 20 * 86400000).toISOString();
  const future = new Date(Date.now() + 40 * 86400000).toISOString();
  const later = new Date(Date.now() + 70 * 86400000).toISOString();
  const insert = DB.sqlite.prepare("INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at) VALUES ('cut-shop', ?, ?, ?, ?)");
  insert.run(past, soon, 'stripe_invoice', past);
  insert.run(future, later, 'stripe_invoice', past);
  insert.run(new Date(Date.now() - 5 * 86400000).toISOString(), null, 'admin', past);
  const running = () => DB.sqlite.prepare("SELECT starts_at, ends_at FROM ambassador_paid_coverage WHERE shop_id = 'cut-shop' AND (ends_at IS NULL OR (ends_at > starts_at AND ends_at > ?))").all(new Date().toISOString());

  assert.equal((await call('POST', '/admin/accounts/cut-shop/status', { suspended: true })).status, 200);
  assert.deepEqual(running(), [], 'nothing covers time after the suspension');

  const start = Math.floor(Date.now() / 1000);
  await signedWebhook(env, { id: 'evt_paid_while_suspended', type: 'invoice.paid', data: { object: {
    id: 'in_paid_while_suspended', metadata: { shopId: 'cut-shop' }, amount_paid: 13900, lines: { data: [membershipLine(start, 13900)] },
  } } });
  assert.deepEqual(running(), [], 'a payment while suspended adds no coverage');
  assert.equal((await call('POST', '/admin/accounts/cut-shop/subscription', { mode: 'active' })).status, 200);
  assert.deepEqual(running(), [], 'activating a suspended account adds no coverage');

  assert.equal((await call('POST', '/admin/accounts/cut-shop/status', { suspended: false })).status, 200);
  assert.deepEqual(running(), [], 'restoring the account brings no coverage back');

  assert.equal((await call('POST', '/admin/accounts/cut-shop/subscription', { mode: 'active' })).status, 200);
  assert.equal(running().length, 1, 'a fresh activation after the restore starts new coverage');
});

test('admin grants are explicit and retry-safe, and trial or Stripe billing ends them', async () => {
  const { call, DB, env } = setup();
  await createShop(call, 'grant-shop', { accountMode: 'trialing' });
  DB.sqlite.prepare("UPDATE subscriptions SET stripe_subscription_id = 'sub_old', current_period_end = NULL WHERE shop_id = 'grant-shop'").run();
  const open = () => DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_paid_coverage WHERE shop_id = 'grant-shop' AND source = 'admin' AND ends_at IS NULL").get().n;

  assert.equal((await call('POST', '/admin/accounts/grant-shop/subscription', { mode: 'active' })).status, 200);
  assert.equal(open(), 1, 'a manual activation counts even with an old Stripe ID on file');
  DB.sqlite.prepare('DELETE FROM ambassador_paid_coverage WHERE shop_id = ?').run('grant-shop');
  assert.equal((await call('POST', '/admin/accounts/grant-shop/subscription', { mode: 'active' })).status, 200);
  assert.equal(open(), 1, 'a retry on an already-active membership repairs missing coverage');
  assert.equal((await call('POST', '/admin/accounts/grant-shop/subscription', { mode: 'active' })).status, 200);
  assert.equal(open(), 1, 'and never stacks a second grant');

  await call('POST', '/admin/accounts/grant-shop/subscription', { mode: 'trialing' });
  assert.equal(open(), 0, 'trial ends the grant');

  await call('POST', '/admin/accounts/grant-shop/subscription', { mode: 'active' });
  await signedWebhook(env, { id: 'evt_switch_checkout', type: 'checkout.session.completed', data: { object: {
    id: 'cs_switch', subscription: 'sub_new', metadata: { shopId: 'grant-shop', planId: 'shop' },
  } } });
  assert.equal(open(), 0, 'moving onto Stripe billing ends the admin grant');
});

test('backfill retains restorable suspended coverage and never treats a trial start as paid', () => {
  const before = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql') && name < '0023').sort();
  const DB = createD1(before);
  for (const id of ['was-trial', 'suspended-now']) {
    DB.sqlite.prepare("INSERT INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at) VALUES (?, ?, ?, 'America/Chicago', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(id, id, id);
  }
  DB.sqlite.prepare("INSERT INTO subscriptions (shop_id, plan_id, status, created_at, updated_at) VALUES ('was-trial', 'shop', 'active', '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')").run();
  DB.sqlite.prepare("INSERT INTO subscriptions (shop_id, plan_id, status, current_period_start, current_period_end, updated_at) VALUES ('suspended-now', 'shop', 'active', '2026-02-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')").run();
  DB.sqlite.prepare("INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, suspended, created_at, updated_at, created_by) VALUES ('suspended-now', 'Suspended', 'o@shops.test', 'Owner', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'admin')").run();
  DB.sqlite.exec(readFileSync(new URL('../migrations/0023_ambassador_paid_coverage.sql', import.meta.url), 'utf8'));
  const rows = DB.sqlite.prepare('SELECT shop_id, starts_at, ends_at, paid_through, cut_reason, source FROM ambassador_paid_coverage ORDER BY shop_id').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { shop_id: 'suspended-now', starts_at: '2026-02-01T00:00:00.000Z', ends_at: '2026-02-01T00:00:00.000Z', paid_through: '2026-04-01T00:00:00.000Z', cut_reason: 'suspension', source: 'admin' },
    { shop_id: 'was-trial', starts_at: '2026-03-01T00:00:00.000Z', ends_at: null, paid_through: null, cut_reason: null, source: 'admin' },
  ]);
});

test('stale subscription events cannot cut newer invoice-backed coverage', async () => {
  const { call, DB, env } = setup();
  await createShop(call, 'out-of-order-coverage', { accountMode: 'trialing' });
  DB.sqlite.prepare(`
    UPDATE subscriptions SET status = 'active', stripe_subscription_id = 'sub_ordered'
    WHERE shop_id = 'out-of-order-coverage'
  `).run();
  DB.sqlite.prepare('DELETE FROM ambassador_paid_coverage WHERE shop_id = ?').run('out-of-order-coverage');
  const start = Math.floor(Date.now() / 1000) - 86400;
  await signedWebhook(env, {
    id: 'evt_newer_invoice', type: 'invoice.paid', created: 300,
    data: { object: {
      id: 'in_newer_invoice', metadata: { shopId: 'out-of-order-coverage' }, amount_paid: 13900,
      lines: { data: [membershipLine(start, 13900)] },
    } },
  });
  await signedWebhook(env, {
    id: 'evt_older_subscription', type: 'customer.subscription.updated', created: 200,
    data: { object: {
      id: 'sub_ordered', status: 'incomplete', current_period_start: start - 30 * 86400,
      metadata: { shopId: 'out-of-order-coverage', planId: 'shop' },
    } },
  });

  assert.equal(subscription(DB, 'out-of-order-coverage').status, 'active');
  assert.equal(DB.sqlite.prepare(`
    SELECT COUNT(*) AS n FROM ambassador_paid_coverage
    WHERE shop_id = 'out-of-order-coverage' AND source = 'stripe_invoice' AND cut_reason IS NULL
  `).get().n, 1);
});

test('invoice.paid keeps payment evidence before activation, reads ID-only lines, and still restores billing', async () => {
  const membershipPrice = 'price_membershipShop';
  const { call, DB, env } = setup({ STRIPE_PRICE_SHOP_MONTHLY: membershipPrice });
  const amb = await createAmbassador(call);
  await createShop(call, 'early-invoice', { accountMode: 'trialing', soldByAmbassadorId: amb.id });
  await createShop(call, 'usage-only', { soldByAmbassadorId: amb.id });
  DB.sqlite.prepare("UPDATE subscriptions SET status = 'past_due', stripe_subscription_id = 'sub_usage' WHERE shop_id = 'usage-only'").run();
  DB.sqlite.prepare('DELETE FROM ambassador_paid_coverage').run();
  const start = Math.floor(Date.now() / 1000) - 86400;
  const idOnly = (price, amount, extra = {}) => ({ amount, period: { start, end: start + 30 * 86400 }, pricing: { price_details: { price } }, parent: { type: 'subscription_item_details' }, ...extra });

  await signedWebhook(env, { id: 'evt_early', type: 'invoice.paid', data: { object: {
    id: 'in_early', metadata: { shopId: 'early-invoice' }, amount_paid: 13900,
    lines: { data: [idOnly('price_meteredUsage', 300), idOnly(membershipPrice, 13900)] },
  } } });
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_paid_coverage WHERE shop_id = 'early-invoice'").get().n, 1, 'paid while still trialing is kept');

  await signedWebhook(env, { id: 'evt_usage_only', type: 'invoice.paid', data: { object: {
    id: 'in_usage_only', subscription: 'sub_usage', metadata: { shopId: 'usage-only' }, amount_paid: 300,
    lines: { data: [idOnly('price_meteredUsage', 300), idOnly(membershipPrice, 13900, { discount_amounts: [{ amount: 13900 }] })] },
  } } });
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_paid_coverage WHERE shop_id = 'usage-only'").get().n, 0, 'an unknown ID-only usage line is not a membership fee');
  assert.equal(subscription(DB, 'usage-only').status, 'active', 'the payment still restores billing access');
});
