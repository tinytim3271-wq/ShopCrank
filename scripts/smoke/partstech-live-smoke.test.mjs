import test from 'node:test';
import assert from 'node:assert/strict';
import { runPartstechSandboxSmoke } from './partstech-live-smoke.mjs';

const sandboxEnv = {
  PARTSTECH_SANDBOX: '1',
  PARTSTECH_SANDBOX_BASE_URL: 'https://sandbox-api.partstech.com/v1',
  PARTSTECH_SANDBOX_STORE_ID: 'store-77',
  PARTSTECH_SANDBOX_PART_NUMBER: 'D1092',
  PARTSTECH_SANDBOX_PARTNER_ID: 'partner-id',
  PARTSTECH_SANDBOX_PARTNER_KEY: 'partner-secret',
  PARTSTECH_SANDBOX_USER_ID: 'user-id',
  PARTSTECH_SANDBOX_USER_KEY: 'user-secret',
};

test('PartsTech live smoke requires explicit opt-in and sandbox credentials', async () => {
  await assert.rejects(runPartstechSandboxSmoke({}), /PARTSTECH_SANDBOX=1/);
  await assert.rejects(runPartstechSandboxSmoke({ ...sandboxEnv, PARTSTECH_SANDBOX_PARTNER_KEY: '' }), /Missing required sandbox configuration/);
  await assert.rejects(
    runPartstechSandboxSmoke({ ...sandboxEnv, PARTSTECH_SANDBOX_BASE_URL: 'https://api.partstech.com' }),
    /must use an HTTPS sandbox\/test host/,
  );
  await assert.rejects(
    runPartstechSandboxSmoke({ ...sandboxEnv, PARTSTECH_SANDBOX_BASE_URL: 'https://sandbox.example.test' }),
    /must use an HTTPS sandbox\/test host/,
  );
});

test('PartsTech live smoke quotes, creates a checkout session, and checks its status without submitting purchase', async () => {
  const calls = [];
  const messages = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (String(url).endsWith('/oauth/access')) return Response.json({ accessToken: 'token' });
    if (String(url).endsWith('/catalog/quote')) {
      return Response.json({ parts: [{ partId: 'p-1', partNumber: 'D1092', price: { list: 68.99 } }] });
    }
    if (String(url).endsWith('/punchout/quote/create')) {
      return Response.json({ sessionId: 'sandbox-session-1', redirectUrl: 'https://app.partstech.com/punchout/sandbox-session-1' });
    }
    return Response.json({ orders: [{ status: 'checkout_pending' }] });
  };
  const result = await runPartstechSandboxSmoke(sandboxEnv, fetcher, { log: message => messages.push(message) });
  assert.equal(result.partNumber, 'D1092');
  assert.equal(result.status, 'checkout_pending');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/v1/oauth/access',
    '/v1/catalog/quote',
    '/v1/punchout/quote/create',
    '/v1/punchout/quote/info',
  ]);
  assert.deepEqual(calls[2].body.parts, [{ partNumber: 'D1092', quantity: 1, partId: 'p-1' }]);
  assert.equal(JSON.stringify(messages).includes('partner-secret'), false);
  assert.match(messages[1], /No purchase was submitted/);
});
