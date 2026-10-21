import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { handleFiles } from '../src/routes/files.mjs';
import { HttpError } from '../src/http.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';

const ORIGIN = 'https://app.example.test';

function tokenDb({ authMethod = 'magic_link', onBatch = () => {} } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/FROM login_tokens/.test(sql)) {
                return {
                  id: 'login-1', email: 'owner@example.test', return_to: '/app',
                  expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null, auth_method: authMethod,
                };
              }
              if (/FROM users WHERE email/.test(sql)) {
                return { id: 'user-1', email: 'owner@example.test', shop_id: 'shop-1', role: 'admin', name: 'Owner', enabled: 1 };
              }
              return null;
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
    async batch(statements) { onBatch(statements); return statements.map(() => ({ success: true })); },
  };
}

test('opening an emailed sign-in link shows a confirm page and does not spend the token', async () => {
  let batches = 0;
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/callback?token=${'a'.repeat(32)}`),
    { DB: tokenDb({ onBatch: () => { batches += 1; } }) },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.equal(response.headers.get('Set-Cookie'), null);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/api\/auth\/callback">/);
  assert.match(html, new RegExp(`name="token" value="${'a'.repeat(32)}"`));
  assert.equal(batches, 0, 'a GET (e.g. a link scanner) must not create a session');
  // no-referrer would make the browser send Origin: null and fail the CSRF check.
  assert.notEqual(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.doesNotMatch(html, /no-referrer/);
});

test('the confirm POST must come from ShopCrank (no login CSRF)', async () => {
  for (const origin of ['https://evil.example', null]) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin) headers.Origin = origin;
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/callback`, { method: 'POST', headers, body: `token=${'b'.repeat(32)}` }),
      { DB: tokenDb({ onBatch: () => assert.fail('must not create a session') }) },
    );
    assert.equal(response.status, 403, `origin ${origin}`);
  }
});

test('Google handoff tokens still sign in directly on GET (desktop deep links rely on this)', async () => {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/callback?token=${'c'.repeat(32)}`),
    { DB: tokenDb({ authMethod: 'google' }) },
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('Set-Cookie') || '', /^shopcrank_session=/);
});

test('sign-in emails are limited per client IP', async () => {
  const env = { DB: createD1(), AUTH_EXPOSE_LOGIN_LINK: '1' };
  const send = (i, ip = '203.0.113.7') => worker.fetch(new Request(`${ORIGIN}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ email: `person${i}@example.org` }),
  }), env);
  for (let i = 0; i < 10; i += 1) assert.equal((await send(i)).status, 200, `request ${i + 1}`);
  const limited = await send(10);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await send(11, '198.51.100.9')).status, 200, 'another client is unaffected');
});

test('file uploads only accept image and PDF types', async () => {
  const request = new Request('https://example.test/api/files/upload?key=shops/shop-1/intake/x', {
    method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: '<script>alert(1)</script>', duplex: 'half',
  });
  await assert.rejects(
    () => handleFiles(request, { FILES: { async put() { assert.fail('must not store'); } } }, { shopId: 'shop-1', userId: 'u1' }, ['files', 'upload']),
    error => error instanceof HttpError && error.status === 415,
  );
});

test('stored files never render as pages: unknown types download, all responses are sandboxed', async () => {
  const stored = type => ({
    body: 'x', httpEtag: '"e"',
    writeHttpMetadata(headers) { headers.set('Content-Type', type); },
  });
  const get = async type => handleFiles(
    new Request('https://example.test/api/files/object?key=shops/shop-1/intake/x'),
    { FILES: { async get() { return stored(type); } } },
    { shopId: 'shop-1', userId: 'u1' },
    ['files', 'object'],
  );
  const html = await get('text/html');
  assert.equal(html.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(html.headers.get('Content-Disposition'), 'attachment');
  assert.match(html.headers.get('Content-Security-Policy'), /sandbox/);
  const photo = await get('image/jpeg');
  assert.equal(photo.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(photo.headers.get('Content-Disposition'), null);
  assert.equal(photo.headers.get('X-Content-Type-Options'), 'nosniff');
});

async function emailSignIn(env, body) {
  const start = await worker.fetch(new Request(`${ORIGIN}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify(body),
  }), env);
  assert.equal(start.status, 200);
  const emailToken = new URL((await start.json()).loginUrl).searchParams.get('token');
  const confirm = await worker.fetch(new Request(`${ORIGIN}/api/auth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: `token=${emailToken}`,
  }), env);
  return { emailToken, confirm };
}

test('email sign-in started in the desktop app hands the session back to the app', async () => {
  const env = { DB: createD1(), AUTH_EXPOSE_LOGIN_LINK: '1' };
  const { emailToken, confirm } = await emailSignIn(env, { email: 'desk@example.org', returnTo: '/', desktop: true });
  // The browser that opened the email link gets an "Open ShopCrank" page, not a session.
  assert.equal(confirm.status, 200);
  assert.equal(confirm.headers.get('Set-Cookie'), null);
  const html = await confirm.text();
  const handoff = (html.match(/shopcrank:\/\/auth\?token=([a-f0-9]{32})/) || [])[1];
  assert.ok(handoff, 'handoff deep link present');
  assert.notEqual(handoff, emailToken);
  assert.match(html, /Sign-in confirmed/);
  // The emailed link is spent.
  const reuse = await worker.fetch(new Request(`${ORIGIN}/api/auth/callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: `token=${emailToken}`,
  }), env);
  assert.equal(reuse.status, 401);
  // The app opens shopcrank://auth?token=… as GET /api/auth/callback and is signed in directly.
  const app = await worker.fetch(new Request(`${ORIGIN}/api/auth/callback?token=${handoff}`), env);
  assert.equal(app.status, 302);
  assert.match(app.headers.get('Set-Cookie') || '', /^shopcrank_session=/);
  assert.equal(new URL(app.headers.get('Location')).pathname, '/');
  assert.doesNotMatch(app.headers.get('Location'), /desktop/);
  // One use only.
  const again = await worker.fetch(new Request(`${ORIGIN}/api/auth/callback?token=${handoff}`), env);
  assert.equal(again.status, 401);
});

test('browser email sign-in still signs the browser in on confirm', async () => {
  const env = { DB: createD1(), AUTH_EXPOSE_LOGIN_LINK: '1' };
  const { confirm } = await emailSignIn(env, { email: 'web@example.org', returnTo: '/' });
  assert.equal(confirm.status, 302);
  assert.match(confirm.headers.get('Set-Cookie') || '', /^shopcrank_session=/);
});
