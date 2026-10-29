import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { mintCapabilityToken, signedRepairOrderForKeys, verifyCapabilityToken } from '../src/diagnostics.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';

const VIN = '1C6SRFHT0LN123456';

async function setup() {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.sqlite.exec(`
    INSERT INTO shops (id, name, slug, created_at, updated_at) VALUES ('shop-a', 'Shop A', 'shop-a', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('shop-a', 'shop_pro', 'active', '${now}');
    INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES
      ('owner@a.test', 'shop-a', 'admin', 'Dana', '${now}', '${now}'),
      ('tech@a.test', 'shop-a', 'technician', 'Sam', '${now}', '${now}');
  `);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    INTEGRATION_ENCRYPTION_KEY: 'test-integration-key-0123456789',
    AUTOAUTH_UNLOCK_URL: 'https://autoauth.example.test/unlock',
    DIAGNOSTICS_SIGNING_PRIVATE_KEY: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'),
  };
  const call = async (email, path, body) => {
    const response = await worker.fetch(new Request(`https://www.shopcrank.com/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': email },
      body: JSON.stringify(body),
    }), env, {});
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    return { status: response.status, body: parsed };
  };
  return { env, call };
}

test('live SecurityAccess keys are released only for an authorized live job on the same VIN and scope', async (t) => {
  const { env, call } = await setup();
  assert.equal((await call('owner@a.test', '/diagnostics/autoauth', { accountId: 'a', apiKey: 'k' })).status, 201);
  let unlockCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === env.AUTOAUTH_UNLOCK_URL) {
      unlockCalls += 1;
      return Response.json({ keyBase64: 'q83vAA==' });
    }
    return realFetch(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const mint = (overrides = {}) => mintCapabilityToken(env, {
    procedure: 'add_key', vin: VIN, shopId: 'shop-a', mode: 'live', actor: 'tech', ...overrides,
  }).then(result => result.token);
  const request = authorizationToken => call('tech@a.test', '/diagnostics/security-access', {
    vin: VIN, level: 3, scope: 'immobilizer', seedBase64: 'oQ==', authorizationToken,
  });

  for (const [label, token] of [
    ['no token', undefined],
    ['simulate token', await mint({ mode: 'simulate' })],
    ['another vehicle', await mint({ vin: '1C6SRFHT0LN654321' })],
    ['another shop', await mint({ shopId: 'shop-b' })],
    ['flash token for an immobilizer key', await mint({ procedure: 'module_flash' })],
    ['payload swapped under a valid signature', await (async () => {
      const [, , signature] = (await mint({ vin: '1C6SRFHT0LN654321' })).split('.');
      const [, payload] = (await mint()).split('.');
      return `v2.${payload}.${signature}`;
    })()],
  ]) {
    const response = await request(token);
    assert.equal(response.status, 403, label);
  }
  assert.equal(unlockCalls, 0, 'AutoAuth is never asked for a key without authorization');

  const granted = await request(await mint());
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.keyBase64, 'q83vAA==');
  assert.equal(unlockCalls, 1);

  // The level, not the caller's scope label, decides which unlock is released.
  const unlock = (level, authorizationToken, scope) => call('tech@a.test', '/diagnostics/security-access', {
    vin: VIN, level, seedBase64: 'oQ==', authorizationToken, ...(scope ? { scope } : {}),
  });
  assert.equal((await unlock(3, await mint({ procedure: 'module_flash' }), 'flash')).status, 400, 'flash label on the immobilizer level');
  assert.equal((await unlock(7, await mint())).status, 400, 'unsupported level');
  assert.equal((await unlock(5, await mint())).status, 403, 'an immobilizer job cannot unlock programming');
  assert.equal((await unlock(5, await mint({ procedure: 'module_flash' }))).status, 200, 'flash job unlocks programming');
  assert.equal((await unlock(5, await mint({ procedure: 'module_coding' }))).status, 200, 'coding job unlocks programming');
  assert.equal(unlockCalls, 3);
});

test('capability tokens expire', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = { DIAGNOSTICS_SIGNING_PRIVATE_KEY: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64') };
  const { token, payload } = await mintCapabilityToken(env, { procedure: 'add_key', vin: VIN, shopId: 's', mode: 'live' });
  const claims = { shopId: 's', vin: VIN, mode: 'live', scope: 'immobilizer' };
  assert.ok(await verifyCapabilityToken(env, token, claims));
  assert.equal(await verifyCapabilityToken(env, token, { ...claims, nowMs: payload.exp + 1 }), null);
});

test('live key work needs a customer signature on a locked estimate, not just a recorded approval', async () => {
  const DB = createD1();
  const now = new Date().toISOString();
  const put = (id, data) => DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-a', 'orders', id, JSON.stringify({ id, vin: VIN, ...data }), 'u', now, now).runSync();
  const signature = { status: 'approved', type: 'signature', authorizationName: 'Pat', signedAt: now, signatureKey: 'shops/shop-a/sig.png' };
  put('RO-SIGNED', { linesLockedAt: now, estimateApproval: signature });
  put('RO-IN-PERSON', { linesLockedAt: now, estimateApproval: { ...signature, type: 'in_person' } });
  put('RO-UNLOCKED', { estimateApproval: signature });
  put('RO-BAD-DATE', { linesLockedAt: now, estimateApproval: { ...signature, signedAt: 'yesterday' } });
  assert.ok(await signedRepairOrderForKeys(DB, 'shop-a', 'RO-SIGNED', VIN));
  for (const id of ['RO-IN-PERSON', 'RO-UNLOCKED', 'RO-BAD-DATE']) {
    assert.equal(await signedRepairOrderForKeys(DB, 'shop-a', id, VIN), null, id);
  }
});
