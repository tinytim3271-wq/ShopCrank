import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessagingIntegration, handleTwilioStatusWebhook } from '../src/integration-routes.mjs';

const env = {
  TWILIO_ACCOUNT_SID: 'AC1234567890',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890',
  TWILIO_WEBHOOK_URL: 'https://app.example.test',
};

function createDb() {
  let consent = null;
  const messages = [];
  const callbacks = [];
  return {
    messages,
    callbacks,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT status FROM sms_consent/u.test(sql)) return consent;
              if (/SELECT status FROM sms_delivery_callbacks/u.test(sql)) {
                return callbacks.find(item => item.shopId === args[0] && item.sid === args[1]) || null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO sms_consent/u.test(sql)) consent = { status: args[2], source: args[3] };
              if (/INSERT OR IGNORE INTO customer_messages/u.test(sql)) {
                messages.push({
                  id: args[0],
                  shopId: args[1],
                  phone: args[4],
                  direction: args[5],
                  body: args[6],
                  provider: args[7],
                  sid: args[8],
                  status: args[10],
                });
              }
              if (/INSERT INTO sms_delivery_callbacks/u.test(sql)) {
                callbacks.push({ shopId: args[0], sid: args[1], status: args[2] });
              }
              if (/UPDATE customer_messages SET status/u.test(sql)) {
                const message = messages.find(item => item.shopId === args[1] && item.sid === args[2]);
                if (message) message.status = args[0];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

const context = { shopId: 'shop-1', role: 'owner', userId: 'owner-1' };
const request = (action, body) => new Request(`https://app.example.test/api/messaging/${action}`, {
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
