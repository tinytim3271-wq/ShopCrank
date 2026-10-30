import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import worker from '../src/index.js';
import { readWranglerConfig } from '../../scripts/dev-worker-local.mjs';
import {
  HEALTH_CHECK_CRON,
  HEALTH_LOG_PREFIX,
  deliverHealthReport,
  evaluateStripeEndpoints,
  handleHealthCheckAdmin,
  healthLogKey,
  persistHealthRun,
  runHealthCheck,
  runScheduledHealthCheck,
  toJsonl,
} from '../src/health/health-check.mjs';
import { TOOL_CONTRACTS, TOOL_CONTRACTS_VERSION } from '../src/health/tool-contracts.mjs';

const ORIGIN = 'https://www.shopcrank.com';
const SHOP = 'shop-a1b2c3';
const ENTRY_FIELDS = ['timestamp', 'runId', 'trigger', 'dryRun', 'contractVersion', 'tool', 'dependency', 'probe', 'shopId', 'status', 'latencyMs', 'error'];

function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options = {}) { objects.set(key, { value: String(value), ...options }); },
    async get(key) {
      const object = objects.get(key);
      return object ? { text: async () => object.value } : null;
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, limit);
      return { objects: keys.map(key => ({ key, size: objects.get(key).value.length, customMetadata: objects.get(key).customMetadata })) };
    },
  };
}

/** D1 with one shop that connected Stripe, QuickBooks and PartsTech; secrets kept in plaintext for the test. */
function setup({ secrets = {} } = {}) {
  const DB = createD1();
  const values = {
    'stripe-secret-key': 'sk_test_shop',
    'stripe-webhook-secret': 'whsec_shop',
    'quickbooks-oauth': JSON.stringify({ realmId: '9130', refreshToken: 'rt-1', accessToken: 'at-1', tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    'partstech-credentials': JSON.stringify({ partnerId: 'p', partnerKey: 'pk', userId: 'u', userKey: 'uk' }),
    ...secrets,
  };
  const store = new Map();
  for (const [name, value] of Object.entries(values)) {
    if (value == null) continue;
    store.set(`${SHOP}:${name}`, value);
    DB.sqlite.prepare("INSERT INTO integration_secrets (shop_id, secret_name, ciphertext, iv, updated_at) VALUES (?, ?, 'x', 'x', '2026-10-30')").run(SHOP, name);
  }
  const saved = [];
  return {
    DB,
    store,
    saved,
    getSecret: async (_env, shopId, name) => store.get(`${shopId}:${name}`) || '',
    saveSecret: async (_env, shopId, name, value) => { saved.push({ shopId, name }); store.set(`${shopId}:${name}`, value); },
  };
}

function baseEnv(DB, extra = {}) {
  return {
    DB,
    FILES: fakeR2(),
    QUICKBOOKS_CLIENT_ID: 'client',
    QUICKBOOKS_CLIENT_SECRET: 'secret',
    SUPPORT_EMAIL_TO: 'support@shopcrank.com',
    AUTH_EMAIL_FROM: 'noreply@shopcrank.com',
    HEALTHCHECK_CANARY_SHOP_ID: 'healthcheck-canary',
    ...extra,
  };
}

/** Fetcher that answers the third-party APIs the probes call and records every URL. */
function fakeFetcher({ stripeEndpoints, partstechOk = true, qboOk = true } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(String(url));
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).startsWith('https://api.stripe.com/v1/webhook_endpoints')) {
      assert.match(init.headers.Authorization, /^Basic /);
      return reply({ data: stripeEndpoints ?? [{ url: `${ORIGIN}/api/payments/webhook/${SHOP}`, status: 'enabled', enabled_events: ['checkout.session.completed'] }] });
    }
    if (String(url).endsWith('/oauth/access')) return partstechOk ? reply({ accessToken: 'tok' }) : reply({ message: 'invalid partner key' }, 401);
    if (String(url).includes('/companyinfo/')) return qboOk ? reply({ CompanyInfo: { CompanyName: 'Demo Auto' } }) : reply({ Fault: { Error: [{ Message: 'AuthenticationFailed', Detail: 'token revoked' }] } }, 401);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetcher, calls };
}

function noNetwork() {
  return async (url) => { throw new Error(`dry run must not call ${url}`); };
}

test('a live run pings D1, inventory, QuickBooks and Stripe webhooks and logs one JSON line per tool and dependency', async () => {
  const { DB, getSecret, saveSecret } = setup();
  const env = baseEnv(DB);
  const { fetcher, calls } = fakeFetcher();
  const run = await runHealthCheck(env, { fetcher, getSecret, saveSecret });

  assert.equal(run.ok, true, JSON.stringify(run.probes.filter(item => item.status !== 'ok' && item.status !== 'not_configured')));
  assert.equal(run.dryRun, false);
  assert.equal(run.contractVersion, TOOL_CONTRACTS_VERSION);
  const byProbe = Object.fromEntries(run.probes.map(item => [item.probe, item]));
  for (const name of ['d1.select', 'inventory.d1', 'inventory.partstech', 'quickbooks.companyinfo', 'stripe.shop_webhook']) {
    assert.equal(byProbe[name]?.status, 'ok', name);
    assert.ok(Number.isFinite(byProbe[name].latencyMs));
  }
  assert.equal(byProbe['stripe.billing'].status, 'not_configured');
  assert.ok(calls.some(url => url.includes('/companyinfo/9130')));
  assert.ok(calls.some(url => url.endsWith('/oauth/access')));

  for (const entry of run.entries) {
    for (const field of ENTRY_FIELDS) assert.ok(field in entry, `${field} missing from ${JSON.stringify(entry)}`);
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  }
  const lines = toJsonl(run.entries).trimEnd().split('\n');
  assert.equal(lines.length, run.entries.length);
  lines.forEach(line => JSON.parse(line));
  assert.ok(run.entries.some(entry => entry.tool === 'lookup_parts' && entry.dependency === 'inventory' && entry.probe === 'inventory.d1'));
  assert.ok(run.entries.some(entry => entry.tool === 'request_quickbooks_sync' && entry.dependency === 'quickbooks' && entry.shopId === SHOP));
  assert.ok(run.entries.some(entry => entry.tool === 'payments.stripe_webhook' && entry.dependency === 'stripe-webhooks'));
  const canaries = run.entries.filter(entry => entry.dependency === 'tool-contract');
  assert.equal(canaries.length, Object.values(TOOL_CONTRACTS).filter(contract => contract.canary).length);
  const gated = name => Boolean(TOOL_CONTRACTS[name].canary.requires);
  assert.ok(canaries.every(entry => entry.status === (gated(entry.tool) ? 'not_configured' : 'ok')), JSON.stringify(canaries.filter(entry => entry.status !== 'ok')));
});

test('failures carry status, latency and the error payload', async () => {
  const { DB, getSecret, saveSecret } = setup();
  const env = baseEnv(DB);
  const { fetcher } = fakeFetcher({ stripeEndpoints: [], partstechOk: false, qboOk: false });
  const run = await runHealthCheck(env, { fetcher, getSecret, saveSecret });
  assert.equal(run.ok, false);
  const byProbe = Object.fromEntries(run.probes.map(item => [item.probe, item]));
  assert.equal(byProbe['inventory.partstech'].status, 'down');
  assert.match(byProbe['inventory.partstech'].error.message, /invalid partner key/);
  assert.equal(byProbe['quickbooks.companyinfo'].status, 'down');
  assert.match(byProbe['quickbooks.companyinfo'].error.message, /AuthenticationFailed|token revoked/);
  assert.equal(byProbe['stripe.shop_webhook'].status, 'down');
  assert.equal(byProbe['stripe.shop_webhook'].error.code, 'webhook_missing');
  assert.equal(byProbe['d1.select'].status, 'ok');
  assert.equal(run.counts.down, run.entries.filter(entry => entry.status === 'down').length);
  const entry = run.entries.find(item => item.probe === 'quickbooks.companyinfo');
  assert.equal(entry.status, 'down');
  assert.ok(entry.error && !('stack' in entry.error));
});

test('a D1 outage and a slow dependency are reported as down, not thrown', async () => {
  const { getSecret, saveSecret } = setup();
  const brokenDb = { prepare() { throw new Error('D1_ERROR: database unavailable'); } };
  const run = await runHealthCheck(baseEnv(brokenDb, { HEALTHCHECK_TIMEOUT_MS: '50' }), { fetcher: noNetwork(), getSecret, saveSecret });
  const d1 = run.probes.find(item => item.probe === 'd1.select');
  assert.equal(d1.status, 'down');
  assert.match(d1.error.message, /database unavailable/);
  assert.ok(run.entries.filter(entry => entry.dependency === 'tool-contract').some(entry => entry.status === 'down'));

  const { DB, getSecret: get2, saveSecret: save2 } = setup();
  const hang = () => new Promise(() => {});
  const slow = await runHealthCheck(baseEnv(DB, { HEALTHCHECK_TIMEOUT_MS: '50' }), { fetcher: hang, getSecret: get2, saveSecret: save2 });
  const stripe = slow.probes.find(item => item.probe === 'stripe.shop_webhook');
  assert.equal(stripe.status, 'down');
  assert.equal(stripe.error.code, 'timeout');
  assert.ok(stripe.latencyMs >= 45);
});

test('dry run validates config without third-party calls, token refresh, storage or email', async () => {
  const { DB, getSecret, saveSecret, saved } = setup({ secrets: {
    'quickbooks-oauth': JSON.stringify({ realmId: '9130', refreshToken: 'rt-1', accessToken: 'at-1', tokenExpiresAt: '2020-01-01T00:00:00Z' }),
    'stripe-webhook-secret': 'not-a-signing-secret',
  } });
  const sent = [];
  const env = baseEnv(DB, { EMAIL: { send: async message => sent.push(message) }, HEALTHCHECK_EMAIL_MODE: 'always' });
  const run = await runHealthCheck(env, { dryRun: true, fetcher: noNetwork(), getSecret, saveSecret });
  assert.equal(run.dryRun, true);
  assert.deepEqual(saved, [], 'dry run must not refresh and re-save the QuickBooks token');
  const byProbe = Object.fromEntries(run.probes.map(item => [item.probe, item]));
  assert.equal(byProbe['quickbooks.companyinfo'].status, 'ok');
  assert.match(byProbe['quickbooks.companyinfo'].detail, /dry run/);
  assert.equal(byProbe['inventory.partstech'].status, 'ok');
  assert.equal(byProbe['stripe.shop_webhook'].status, 'down');
  assert.equal(byProbe['stripe.shop_webhook'].error.code, 'webhook_secret_missing');
  assert.ok(run.entries.every(entry => entry.dryRun === true));
  const network = run.canaries.filter(item => TOOL_CONTRACTS[item.tool].canary.network && !TOOL_CONTRACTS[item.tool].canary.requires);
  assert.ok(network.length > 0 && network.every(item => item.status === 'skipped'));

  assert.deepEqual(await persistHealthRun(env, run), { stored: false, reason: 'dry_run' });
  assert.equal(env.FILES.objects.size, 0);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
  assert.deepEqual(await deliverHealthReport(env, run), { sent: false, reason: 'dry_run' });
  assert.deepEqual(sent, []);
});

test('dry run flags missing QuickBooks app credentials and malformed stored PartsTech credentials', async () => {
  const { DB, getSecret, saveSecret } = setup({ secrets: { 'partstech-credentials': '{not json' } });
  const run = await runHealthCheck(baseEnv(DB, { QUICKBOOKS_CLIENT_ID: '' }), { dryRun: true, fetcher: noNetwork(), getSecret, saveSecret });
  const byProbe = Object.fromEntries(run.probes.map(item => [item.probe, item]));
  assert.equal(byProbe['quickbooks.companyinfo'].status, 'down');
  assert.match(byProbe['quickbooks.companyinfo'].error.message, /app credentials/);
  assert.equal(byProbe['inventory.partstech'].status, 'down');
  assert.equal(byProbe['inventory.partstech'].error.code, 'bad_credentials');
});

test('Stripe endpoint evaluation checks path, host, enabled status and the checkout event', () => {
  const hosts = new Set(['www.shopcrank.com']);
  const path = `/api/payments/webhook/${SHOP}`;
  const endpoint = (overrides = {}) => ({ url: `${ORIGIN}${path}`, status: 'enabled', enabled_events: ['checkout.session.completed'], ...overrides });
  assert.equal(evaluateStripeEndpoints([endpoint()], { path, hosts }).status, 'ok');
  assert.equal(evaluateStripeEndpoints([endpoint({ enabled_events: ['*'] })], { path, hosts }).status, 'ok');
  assert.equal(evaluateStripeEndpoints([endpoint({ status: 'disabled' })], { path, hosts }).error.code, 'webhook_disabled');
  assert.equal(evaluateStripeEndpoints([endpoint({ enabled_events: ['invoice.paid'] })], { path, hosts }).error.code, 'webhook_event_missing');
  assert.equal(evaluateStripeEndpoints([endpoint({ url: `https://old.example.com${path}` })], { path, hosts }).error.code, 'webhook_wrong_host');
  assert.equal(evaluateStripeEndpoints([endpoint({ url: `${ORIGIN}/api/payments/webhook/other` })], { path, hosts }).error.code, 'webhook_missing');
  assert.equal(evaluateStripeEndpoints(null, { path, hosts }).status, 'down');
});

test('a live run is stored as JSONL in R2 (newest first) and summarized in the D1 audit log', async () => {
  const { DB, getSecret, saveSecret } = setup();
  const env = baseEnv(DB);
  const first = await runHealthCheck(env, { fetcher: fakeFetcher().fetcher, getSecret, saveSecret, now: () => new Date('2026-10-30T00:00:00Z') });
  const second = await runHealthCheck(env, { fetcher: fakeFetcher({ stripeEndpoints: [] }).fetcher, getSecret, saveSecret, now: () => new Date('2026-10-30T06:30:00Z') });
  const stored = await persistHealthRun(env, first, { userId: 'owner-1', email: 'owner@shopcrank.com' });
  await persistHealthRun(env, second);
  assert.equal(stored.stored, true);
  assert.equal(stored.key, healthLogKey(first));
  assert.ok(stored.key.startsWith(HEALTH_LOG_PREFIX) && stored.key.endsWith('.jsonl'));
  const object = env.FILES.objects.get(stored.key);
  assert.equal(object.value, toJsonl(first.entries));
  assert.equal(object.customMetadata.ok, 'true');
  const listed = await env.FILES.list({ prefix: HEALTH_LOG_PREFIX });
  assert.equal(listed.objects[0].key, healthLogKey(second), 'newest run lists first');

  const rows = DB.sqlite.prepare("SELECT * FROM audit_log WHERE shop_id = 'platform' ORDER BY created_at").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor_email, 'owner@shopcrank.com');
  assert.equal(rows[1].actor_id, 'healthcheck-cron');
  const event = JSON.parse(rows[1].event_json);
  assert.equal(event.kind, 'healthcheck.run');
  assert.equal(event.ok, false);
  assert.ok(event.failures.some(item => item.probe === 'stripe.shop_webhook'));
});

test('the report is emailed on failures (or always when configured), never when healthy by default', async () => {
  const { DB, getSecret, saveSecret } = setup();
  const sent = [];
  const env = baseEnv(DB, { EMAIL: { send: async message => sent.push(message) } });
  const healthy = await runHealthCheck(env, { fetcher: fakeFetcher().fetcher, getSecret, saveSecret });
  assert.deepEqual(await deliverHealthReport(env, healthy), { sent: false, reason: 'healthy' });
  assert.equal((await deliverHealthReport({ ...env, HEALTHCHECK_EMAIL_MODE: 'always' }, healthy)).sent, true);

  const failing = await runHealthCheck(env, { fetcher: fakeFetcher({ qboOk: false }).fetcher, getSecret, saveSecret });
  const delivery = await deliverHealthReport(env, failing, { key: 'health-checks/x.jsonl' });
  assert.deepEqual(delivery, { sent: true, to: 'support@shopcrank.com' });
  const message = sent.at(-1);
  assert.equal(message.from, 'noreply@shopcrank.com');
  assert.match(message.subject, /failing: 1 down, 0 degraded/);
  assert.match(message.text, /quickbooks \/ quickbooks\.companyinfo \(shop shop-a1b2c3\)/);
  assert.match(message.text, /health-checks\/x\.jsonl/);
  assert.ok(message.text.includes(JSON.stringify(failing.entries[0])));
  assert.deepEqual(await deliverHealthReport({ ...env, HEALTHCHECK_EMAIL_MODE: 'off' }, failing), { sent: false, reason: 'disabled' });
  assert.deepEqual(await deliverHealthReport({ ...env, EMAIL: undefined }, failing), { sent: false, reason: 'email_not_configured' });
  assert.equal((await deliverHealthReport({ ...env, HEALTHCHECK_EMAIL_TO: 'ops@shopcrank.com' }, failing)).to, 'ops@shopcrank.com');
});

test('the Worker cron trigger runs the health check, stores the log and emails the report', async () => {
  assert.ok(readWranglerConfig().triggers.crons.includes(HEALTH_CHECK_CRON), 'wrangler.jsonc must schedule HEALTH_CHECK_CRON');
  const { DB } = setup({ secrets: { 'quickbooks-oauth': null, 'partstech-credentials': null, 'stripe-secret-key': null, 'stripe-webhook-secret': null } });
  const sent = [];
  const env = baseEnv(DB, { EMAIL: { send: async message => sent.push(message) }, HEALTHCHECK_EMAIL_MODE: 'always' });
  const waits = [];
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await worker.scheduled({ cron: HEALTH_CHECK_CRON }, env, { waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
  } finally {
    console.log = original;
  }
  assert.equal(waits.length, 1);
  assert.equal(env.FILES.objects.size, 1);
  assert.equal(sent.length, 1);
  const summary = JSON.parse(logged.find(line => line.includes('dependency health check cron')));
  assert.equal(summary.ok, true);
  assert.ok(summary.logKey.startsWith(HEALTH_LOG_PREFIX));
});

test('runScheduledHealthCheck never throws when storage and email are missing', async () => {
  const { DB } = setup();
  const result = await runScheduledHealthCheck({ DB, HEALTHCHECK_TIMEOUT_MS: '200' }, {
    fetcher: noNetwork(),
    getSecret: async () => '',
    saveSecret: async () => {},
  });
  assert.equal(result.run.trigger, 'cron');
  assert.ok(result.storage.errors.some(item => item.store === 'r2'));
  assert.equal(result.storage.stored, true, 'D1 audit row still recorded');
});

test('admin endpoints are platform-owner only; POST defaults to a dry run', async () => {
  const { DB, getSecret, saveSecret } = setup();
  const env = baseEnv(DB);
  const deps = { getSecret, saveSecret, fetcher: noNetwork() };
  const owner = { role: 'super_admin', userId: 'owner-1', email: 'owner@shopcrank.com', shopId: 'platform' };
  const call = (method, path, context = owner, body) => handleHealthCheckAdmin(
    new Request(`${ORIGIN}/api${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }),
    env,
    context,
    path.split('?')[0].split('/').filter(Boolean),
    deps,
  );
  await assert.rejects(call('GET', '/admin/health-check', { role: 'admin', shopId: SHOP }), error => error.status === 403);

  const dry = await (await call('POST', '/admin/health-check')).json();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.storage.reason, 'dry_run');
  assert.equal(dry.delivery.reason, 'not_requested');
  assert.equal(env.FILES.objects.size, 0);

  const live = await (await call('POST', '/admin/health-check', owner, { dryRun: false })).json();
  assert.equal(live.dryRun, false);
  assert.equal(live.storage.stored, true);

  const overview = await (await call('GET', '/admin/health-check')).json();
  assert.equal(overview.schedule, HEALTH_CHECK_CRON);
  assert.equal(overview.contractVersion, TOOL_CONTRACTS_VERSION);
  assert.equal(overview.runs.length, 1);
  assert.equal(overview.runs[0].runId, live.runId);
  const name = overview.runs[0].name;

  const detail = await (await call('GET', `/admin/health-check/runs/${name}`)).json();
  assert.equal(detail.entries.length, live.entries.length);
  const raw = await call('GET', `/admin/health-check/runs/${name}?format=jsonl`);
  assert.match(raw.headers.get('Content-Type'), /ndjson/);
  assert.equal((await raw.text()).trimEnd().split('\n').length, live.entries.length);
  await assert.rejects(call('GET', '/admin/health-check/runs/..%2Fsecret'), error => error.status === 400);
});

test('the admin route is wired through the Worker with platform-owner auth', async () => {
  const { DB } = setup({ secrets: { 'quickbooks-oauth': null, 'partstech-credentials': null, 'stripe-secret-key': null, 'stripe-webhook-secret': null } });
  const env = baseEnv(DB, { DEV_AUTH_BYPASS: '1', ACCESS_ADMIN_EMAILS: 'owner@shopcrank.com' });
  const request = email => new Request(`${ORIGIN}/api/admin/health-check`, {
    method: 'POST',
    headers: { 'X-ShopCrank-Dev-Email': email, 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dryRun: true }),
  });
  const response = await worker.fetch(request('owner@shopcrank.com'), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dryRun, true);
  assert.ok(body.entries.length > 0);
  const denied = await worker.fetch(request('someone@example.com'), env, {});
  assert.equal(denied.status, 403);
});
