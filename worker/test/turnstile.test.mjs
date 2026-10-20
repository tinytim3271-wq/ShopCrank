import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { verifyTurnstile } from '../src/index.js';
import { HttpError } from '../src/http.mjs';

const request = new Request('https://app.example.test/api/auth/magic-link', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
const okFetch = (seen = {}) => async (url, init) => { seen.url = url; seen.body = String(init.body); return Response.json({ success: true }); };

test('Turnstile is off until a secret is configured', async () => {
  let called = false;
  await verifyTurnstile(request, {}, '', async () => { called = true; });
  assert.equal(called, false);
});

test('with a secret, a missing token is refused before any email is sent', async () => {
  await assert.rejects(verifyTurnstile(request, { TURNSTILE_SECRET_KEY: 's' }, ''), (error) => error instanceof HttpError && error.status === 403);
});

test('with a secret, the token and client IP are verified with Cloudflare', async () => {
  const seen = {};
  await verifyTurnstile(request, { TURNSTILE_SECRET_KEY: 'secret-1' }, 'tok-1', okFetch(seen));
  assert.match(seen.url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  assert.match(seen.body, /secret=secret-1/);
  assert.match(seen.body, /response=tok-1/);
  assert.match(seen.body, /remoteip=203\.0\.113\.9/);
});

test('a failed or unreachable check blocks sign-in', async () => {
  await assert.rejects(
    verifyTurnstile(request, { TURNSTILE_SECRET_KEY: 's' }, 't', async () => Response.json({ success: false })),
    (error) => error.status === 403,
  );
  await assert.rejects(
    verifyTurnstile(request, { TURNSTILE_SECRET_KEY: 's' }, 't', async () => { throw new Error('down'); }),
    (error) => error.status === 503,
  );
});

test('magic-link refuses a request without a token when Turnstile is on', async () => {
  const response = await worker.fetch(
    new Request('https://app.example.test/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test' }),
    }),
    { TURNSTILE_SECRET_KEY: 's', AUTH_EXPOSE_LOGIN_LINK: '1', DB: { prepare() { throw new Error('DB must not be touched'); } } },
  );
  assert.equal(response.status, 403);
});

test('/api/auth/config exposes only the public site key', async () => {
  const on = await worker.fetch(new Request('https://app.example.test/api/auth/config'), { TURNSTILE_SITE_KEY: 'site-1', TURNSTILE_SECRET_KEY: 'secret-1' });
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.deepEqual(body, { turnstileSiteKey: 'site-1' });
  const off = await worker.fetch(new Request('https://app.example.test/api/auth/config'), {});
  assert.deepEqual(await off.json(), { turnstileSiteKey: null });
});
