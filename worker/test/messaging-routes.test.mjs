import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleMessagingIntegration, handleTwilioStatusWebhook } from '../src/integration-routes.mjs';

const env = {
  TWILIO_ACCOUNT_SID: 'AC1234567890',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890',
  TWILIO_WEBHOOK_URL: 'https://app.example.test',
};

function createDb({ beforeReconcile = () => {} } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE subscriptions (id TEXT PRIMARY KEY);');
  sqlite.exec(readFileSync(new URL('../migrations/0008_integrations_support.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0017_sms_delivery_callbacks.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    get messages() {
      return sqlite.prepare('SELECT *, shop_id AS shopId, provider_message_id AS sid FROM customer_messages').all();
    },
    get callbacks() {
      return sqlite.prepare('SELECT shop_id AS shopId, provider_message_id AS sid, status FROM sms_delivery_callbacks').all().map(row => ({ ...row }));
    },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/RETURNING status/u.test(sql)) beforeReconcile(sqlite);
              return sqlite.prepare(sql).get(...args) || null;
            },
            async run() {
              sqlite.prepare(sql).run(...args);
              return { success: true };
            },
          };
        },
      };
    },
  };
}

const context = { shopId: 'shop-1', role: 'owner', userId: 'owner-1' };
const request = (action, body) => new Request(`https://worker.internal.example/api/messaging/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('outbound SMS requires recorded explicit consent and stores the delivery callback URL', async () => {
  const DB = createDb();
  const dependencies = { getSecret: async () => '' };
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('StatusCallback'), 'https://app.example.test/api/messaging/twilio/status/shop-1');
    return Response.json({ sid: 'SM12345', status: 'queued' }, { status: 201 });
  };
  try {
    await assert.rejects(
      handleMessagingIntegration(request('send', { to: '+18065550123', body: 'Ready' }), { ...env, DB }, context, ['messaging', 'send'], dependencies),
      error => error.status === 409,
    );
    assert.equal(providerCalls, 0);

    await assert.rejects(
      handleMessagingIntegration(request('consent', { phone: '+18065550123', status: 'opted_in' }), { ...env, DB }, context, ['messaging', 'consent'], dependencies),
      error => error.status === 400,
    );
    await handleMessagingIntegration(request('consent', {
      phone: '+18065550123',
      status: 'opted_in',
      confirmed: true,
    }), { ...env, DB }, context, ['messaging', 'consent'], dependencies);
    const response = await handleMessagingIntegration(
      request('send', { to: '+18065550123', body: 'Ready' }),
      { ...env, DB },
      context,
      ['messaging', 'send'],
      dependencies,
    );
    assert.equal(response.status, 201);
    assert.equal(providerCalls, 1);
    assert.equal(DB.messages[0].status, 'queued');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('signed delivery callbacks persist status even when they arrive before the send record', async () => {
  const DB = createDb();
  const url = 'https://app.example.test/api/messaging/twilio/status/shop-1';
  const parameters = new URLSearchParams({ MessageSid: 'SMcallback1', MessageStatus: 'delivered' });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const data = `${url}MessageSidSMcallback1MessageStatusdelivered`;
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const signature = Buffer.from(digest).toString('base64');
  const response = await handleTwilioStatusWebhook(new Request(
    'https://worker.internal.example/api/messaging/twilio/status/shop-1',
    {
      method: 'POST',
      headers: { 'X-Twilio-Signature': signature },
      body: parameters,
    },
  ), { ...env, DB }, 'shop-1', { getSecret: async () => '' });
  assert.equal(response.status, 204);
  assert.deepEqual(DB.callbacks, [{ shopId: 'shop-1', sid: 'SMcallback1', status: 'delivered' }]);
});

test('send reconciliation atomically reads callbacks and cannot overwrite terminal delivery status', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ sid: 'SMrace', status: 'queued' }, { status: 201 });
  try {
    for (const terminal of ['delivered', 'read', 'undelivered', 'failed', 'canceled']) {
      const DB = createDb({
        beforeReconcile(sqlite) {
          sqlite.prepare("UPDATE customer_messages SET status = ? WHERE provider_message_id = 'SMrace'").run(terminal);
        },
      });
      DB.sqlite.prepare("INSERT INTO sms_delivery_callbacks VALUES ('shop-1', 'SMrace', 'sent', 'now')").run();
      const dependencies = { getSecret: async () => '' };
      await handleMessagingIntegration(request('consent', { phone: '+18065550123', status: 'opted_in', confirmed: true }),
        { ...env, DB }, context, ['messaging', 'consent'], dependencies);
      const response = await handleMessagingIntegration(request('send', { to: '+18065550123', body: 'Ready' }),
        { ...env, DB }, context, ['messaging', 'send'], dependencies);
      assert.equal((await response.json()).status, terminal);
      assert.equal(DB.messages[0].status, terminal);
      DB.sqlite.close();
    }
    const DB = createDb();
    DB.sqlite.prepare("INSERT INTO sms_delivery_callbacks VALUES ('shop-1', 'SMrace', 'delivered', 'now')").run();
    const dependencies = { getSecret: async () => '' };
    await handleMessagingIntegration(request('consent', { phone: '+18065550123', status: 'opted_in', confirmed: true }),
      { ...env, DB }, context, ['messaging', 'consent'], dependencies);
    const response = await handleMessagingIntegration(request('send', { to: '+18065550123', body: 'Ready' }),
      { ...env, DB }, context, ['messaging', 'send'], dependencies);
    assert.equal((await response.json()).status, 'delivered');
    assert.equal(DB.messages[0].status, 'delivered');
    DB.sqlite.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
