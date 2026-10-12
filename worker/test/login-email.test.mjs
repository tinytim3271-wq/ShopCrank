import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const SECRET = 'test-webhook-secret';
const TOKEN = 'a'.repeat(32);

function emailBinding(send = async () => {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      await send(message);
    },
  };
}

function pendingLoginDb(email = 'owner@example.test') {
  return {
    prepare(sql) {
      return {
        bind(hash) {
          return {
            async first() {
              assert.match(sql, /SELECT email FROM login_tokens/);
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN));
              assert.equal(hash, Buffer.from(digest).toString('hex'));
              return { email };
            },
          };
        },
      };
    },
  };
}

function sendLoginRequest({
  secret = SECRET,
  email = 'owner@example.test',
  host = 'www.yourcarguy806.com',
  loginUrl = `https://${host}/api/auth/callback?token=${TOKEN}`,
  authorization = `Bearer ${secret}`,
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authorization !== null) headers.Authorization = authorization;
  return new Request(`https://${host}/api/auth/send-login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, loginUrl, returnTo: '/' }),
  });
}

test('send-login returns 202 only after the provider accepts the message', async (t) => {
  t.mock.method(console, 'error', () => {});
  let accepted = false;
  const EMAIL = emailBinding(async () => { accepted = true; });
  const response = await worker.fetch(sendLoginRequest(), {
    AUTH_EMAIL_WEBHOOK_SECRET: SECRET,
    ALLOWED_ORIGINS: 'https://www.yourcarguy806.com',
    DB: pendingLoginDb(),
    EMAIL,
  });
  assert.equal(accepted, true);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ok, true);
  assert.equal(EMAIL.sent.length, 1);
  assert.match(EMAIL.sent[0].text, new RegExp(TOKEN));
  assert.equal(EMAIL.sent[0].from, 'noreply@yourcarguy806.com');
  assert.equal(EMAIL.sent[0].to, 'owner@example.test');
  assert.equal(EMAIL.sent[0].subject, 'Sign in to MechPro');
});

test('send-login rejects a missing or wrong bearer secret before sending', async (t) => {
  t.mock.method(console, 'error', () => {});
  const EMAIL = emailBinding();
  const env = { AUTH_EMAIL_WEBHOOK_SECRET: SECRET, DB: pendingLoginDb(), EMAIL };
  assert.equal((await worker.fetch(sendLoginRequest({ authorization: null }), env)).status, 401);
  assert.equal((await worker.fetch(sendLoginRequest({ secret: 'wrong-secret' }), env)).status, 401);
  assert.equal(EMAIL.sent.length, 0);
});

test('send-login does not relay links for other sites or other inboxes', async (t) => {
  t.mock.method(console, 'error', () => {});
  const EMAIL = emailBinding();
  const env = {
    AUTH_EMAIL_WEBHOOK_SECRET: SECRET,
    ALLOWED_ORIGINS: 'https://www.yourcarguy806.com',
    DB: pendingLoginDb(),
    EMAIL,
  };
  const foreign = await worker.fetch(sendLoginRequest({
    loginUrl: `https://evil.example/api/auth/callback?token=${TOKEN}`,
  }), env);
  assert.equal(foreign.status, 400);
  const mismatch = await worker.fetch(sendLoginRequest({ email: 'other@example.test' }), env);
  assert.equal(mismatch.status, 400);
  assert.equal(EMAIL.sent.length, 0);
});

test('send-login names the provider rejection when Email Sending cannot reach that address', async (t) => {
  t.mock.method(console, 'error', () => {});
  const rejected = new Error('recipient not allowed');
  rejected.code = 'E_RECIPIENT_NOT_ALLOWED';
  const response = await worker.fetch(sendLoginRequest(), {
    AUTH_EMAIL_WEBHOOK_SECRET: SECRET,
    DB: pendingLoginDb(),
    EMAIL: emailBinding(async () => { throw rejected; }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /cannot receive a MechPro sign-in link yet/);
});

test('send-login returns 502 when the provider rejects the message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const response = await worker.fetch(sendLoginRequest(), {
    AUTH_EMAIL_WEBHOOK_SECRET: SECRET,
    DB: pendingLoginDb(),
    EMAIL: emailBinding(async () => { throw new Error('rejected'); }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).message, 'Unable to deliver the sign-in email');
});
