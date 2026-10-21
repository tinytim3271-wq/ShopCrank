import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import {
  APEX_HOST,
  APP_SESSION_COOKIE,
  CANONICAL_HOST,
  CANONICAL_ORIGIN,
  DEFAULT_AUTH_EMAIL_FROM,
  DEFAULT_PAGES_ORIGIN,
  HEALTHZ_SERVICE,
  LEGACY_APEX_HOST,
  LEGACY_HOST,
} from '../src/production-host.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function parseJsonc(source) {
  const jsonText = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(jsonText);
}

test('wrangler production host is www.shopcrank.com', () => {
  const config = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.name, 'shopcrank-api');
  assert.equal(config.vars.PAGES_ORIGIN, DEFAULT_PAGES_ORIGIN);
  assert.equal(config.vars.AUTH_EMAIL_FROM, DEFAULT_AUTH_EMAIL_FROM);
  const origins = String(config.vars.ALLOWED_ORIGINS).split(',');
  assert.ok(origins.includes(CANONICAL_ORIGIN));
  assert.ok(origins.includes(`https://${APEX_HOST}`));
  assert.ok(origins.includes(DEFAULT_PAGES_ORIGIN));
  assert.equal(config.d1_databases[0].database_name, 'shopcrank');
  assert.equal(config.r2_buckets[0].bucket_name, 'shopcrank-files');
});

test('healthz identifies the ShopCrank Worker', async () => {
  const response = await worker.fetch(new Request(`${CANONICAL_ORIGIN}/api/healthz`), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: HEALTHZ_SERVICE });
});

test('apex shopcrank.com redirects to www for API and Pages paths', async () => {
  const api = await worker.fetch(new Request(`https://${APEX_HOST}/api/healthz`), {});
  assert.equal(api.status, 301);
  assert.equal(api.headers.get('location'), `${CANONICAL_ORIGIN}/api/healthz`);

  const site = await worker.fetch(new Request(`https://${APEX_HOST}/login`), {});
  assert.equal(site.status, 301);
  assert.equal(site.headers.get('location'), `${CANONICAL_ORIGIN}/login`);
});

test('the pre-cutover host redirects to the canonical host, keeping path and query', async () => {
  for (const host of [LEGACY_HOST, LEGACY_APEX_HOST]) {
    const response = await worker.fetch(new Request(`https://${host}/api/auth/session?returnTo=%2Fapp`), {});
    assert.equal(response.status, 301, `${host} should redirect`);
    assert.equal(response.headers.get('location'), `${CANONICAL_ORIGIN}/api/auth/session?returnTo=%2Fapp`);
  }

  const page = await worker.fetch(new Request(`https://${LEGACY_HOST}/pricing/`), {});
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), `${CANONICAL_ORIGIN}/pricing/`);
});

<<<<<<< Updated upstream
test('legacy Stripe webhook POSTs reach signature validation instead of redirecting', async () => {
  const response = await worker.fetch(new Request(
    `https://${LEGACY_HOST}/api/payments/webhook/shop-1`,
    { method: 'POST', body: '{}' },
  ), {});

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
});

test('legacy provider callbacks reach their existing authentication checks', async () => {
  const requests = [
    [new Request(`https://${LEGACY_HOST}/api/billing/webhook`, { method: 'POST', body: '{}' }), {}, 400],
    [new Request(`https://${LEGACY_HOST}/api/agentphone/webhook/shop-1`, { method: 'POST', body: '{}' }), {}, 400],
    [new Request(`https://${LEGACY_HOST}/api/messaging/twilio/webhook/shop-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    }), { TWILIO_AUTH_TOKEN: 'test-twilio-token' }, 401],
    [new Request(`https://${LEGACY_HOST}/api/voice/twilio/incoming/shop-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    }), { TWILIO_AUTH_TOKEN: 'test-twilio-token' }, 401],
    [new Request(`https://${LEGACY_HOST}/api/voice/twilio/stream/shop-1`, {
      headers: { Upgrade: 'websocket' },
    }), {}, 401],
  ];

  for (const [request, env, expectedStatus] of requests) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, expectedStatus, new URL(request.url).pathname);
    assert.equal(response.headers.get('location'), null, new URL(request.url).pathname);
  }
});

test('legacy Twilio voice callbacks return a stream URL on the legacy host', async () => {
  const body = new URLSearchParams({
    From: '+18065550123',
    To: '+18065550999',
    CallSid: 'CA1234567890abcdef',
  });
  const response = await worker.fetch(new Request(
    `https://${LEGACY_HOST}/api/voice/twilio/incoming/shop-1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  ), {
    XAI_API_KEY: 'xai-test-key-1234567890abcdef',
    INTEGRATION_ENCRYPTION_KEY: 'test-encryption-secret-key-for-stream',
    TWILIO_VERIFY_VOICE: '0',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(
    await response.text(),
    /wss:\/\/www\.yourcarguy806\.com\/api\/voice\/twilio\/stream\/shop-1\?token=/,
  );
});

=======
>>>>>>> Stashed changes
test('the canonical host is never redirected', async () => {
  const response = await worker.fetch(new Request(`${CANONICAL_ORIGIN}/api/healthz`), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
});

test('session cookie and desktop start URL use the canonical ShopCrank host', () => {
  assert.equal(APP_SESSION_COOKIE, 'shopcrank_session');
  const startUrl = readFileSync(join(root, 'desktop/start-url.js'), 'utf8');
  assert.match(startUrl, new RegExp(`DEFAULT_DESKTOP_APP_URL = '${CANONICAL_ORIGIN}/'`));
  const redirects = readFileSync(join(root, 'public/_redirects'), 'utf8');
  assert.match(redirects, new RegExp(`https://${APEX_HOST}/\\* https://${CANONICAL_HOST}/:splat 301`));
});
