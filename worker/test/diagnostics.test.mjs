import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DIAGNOSTIC_PROCEDURES, PROGRAMMING_MODES, mintCapabilityToken, procedureSpec, signedRepairOrderForKeys } from '../src/diagnostics.mjs';

const require = createRequire(import.meta.url);
const { verifyCapabilityToken } = require('../../diagnostics/j2534-host-node/capability-token.js');

async function generateKeyEnv() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  return { pkcs8, spki };
}

test('procedure specs cover programming + flash', () => {
  assert.ok(procedureSpec('clear_dtcs'));
  assert.equal(procedureSpec('module_flash').klass, 'flash');
  assert.equal(procedureSpec('add_key').autoAuth, true);
  assert.equal(procedureSpec('module_coding').klass, 'coding');
  assert.equal(procedureSpec('bidirectional_control').klass, 'bidirectional');
  assert.equal(procedureSpec('module_coding').autoAuth, true);
  assert.equal(procedureSpec('clear_dtcs').autoAuth, false);
  assert.equal(procedureSpec('nope'), null);
  assert.ok(PROGRAMMING_MODES.has('simulate') && PROGRAMMING_MODES.has('live'));
  assert.ok(Object.keys(DIAGNOSTIC_PROCEDURES).includes('module_flash'));
});

test('Worker-minted ECDSA token verifies in the host verifier (cross-runtime)', async () => {
  const { pkcs8, spki } = await generateKeyEnv();
  const env = { DIAGNOSTICS_SIGNING_PRIVATE_KEY: pkcs8 };
  process.env.DIAGNOSTICS_SIGNING_PUBLIC_KEY = spki;

  const { token, payload } = await mintCapabilityToken(env, {
    procedure: 'module_flash', vin: '1C6SRFHT0LN123456', shopId: 'shop-1', mode: 'live', actor: 'user-1',
  });
  assert.equal(payload.v, 2);
  assert.equal(payload.scope, 'flash');

  const verified = verifyCapabilityToken(token, { procedure: 'module_flash', mode: 'live', consume: false });
  assert.equal(verified.vin, '1C6SRFHT0LN123456');
  assert.equal(verified.mode, 'live');

  // Procedure / mode mismatches are rejected.
  assert.throws(() => verifyCapabilityToken(token, { procedure: 'add_key', consume: false }), /not valid for add_key/);
  assert.throws(() => verifyCapabilityToken(token, { mode: 'simulate', consume: false }), /mode mismatch/);
});

test('a client holding only the public key cannot forge a token', async () => {
  const { spki } = await generateKeyEnv();
  process.env.DIAGNOSTICS_SIGNING_PUBLIC_KEY = spki;
  // Forge attempt: a different (attacker) key signs a look-alike token.
  const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const attackerPkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', attacker.privateKey)).toString('base64');
  const { token } = await mintCapabilityToken({ DIAGNOSTICS_SIGNING_PRIVATE_KEY: attackerPkcs8 }, {
    procedure: 'clear_dtcs', vin: '1C6SRFHT0LN123456', shopId: 'shop-1', mode: 'simulate',
  });
  assert.throws(() => verifyCapabilityToken(token, { consume: false }), /signature/);
});

test('single-use consumption is enforced with expiry pruning', async () => {
  const { pkcs8, spki } = await generateKeyEnv();
  process.env.DIAGNOSTICS_SIGNING_PUBLIC_KEY = spki;
  const { token } = await mintCapabilityToken({ DIAGNOSTICS_SIGNING_PRIVATE_KEY: pkcs8 }, {
    procedure: 'clear_dtcs', vin: '1C6SRFHT0LN123456', shopId: 'shop-1', mode: 'simulate',
  });
  assert.ok(verifyCapabilityToken(token, {}));
  assert.throws(() => verifyCapabilityToken(token, {}), /already used/);
});

function entitiesDb({ order, estimates = [] }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => (sql.includes("'orders'") && order ? { data_json: JSON.stringify(order) } : null),
            all: async () => ({ results: estimates.map((estimate) => ({ data_json: JSON.stringify(estimate) })) }),
          };
        },
      };
    },
  };
}

test('live key authorization needs a signed repair order for the same VIN', async () => {
  const vin = '1C6SRFHT0LN123456';
  const order = { id: 'RO-1', vin };
  const signed = { id: 'E-1', workOrderId: 'RO-1', status: 'approved', signedAt: '2026-10-01T00:00:00Z', authorizationName: 'Pat Customer' };
  const ok = await signedRepairOrderForKeys(entitiesDb({ order, estimates: [signed] }), 'shop-1', 'RO-1', vin);
  assert.equal(ok.authorizationName, 'Pat Customer');
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order, estimates: [{ ...signed, signedAt: '' }] }), 'shop-1', 'RO-1', vin), null);
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order, estimates: [{ ...signed, status: 'sent' }] }), 'shop-1', 'RO-1', vin), null);
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order: { ...order, vin: '1C6SRFHT0LN999999' }, estimates: [signed] }), 'shop-1', 'RO-1', vin), null);
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order, estimates: [{ ...signed, workOrderId: 'RO-2' }] }), 'shop-1', 'RO-1', vin), null);
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order: null, estimates: [signed] }), 'shop-1', 'RO-1', vin), null);
  assert.equal(await signedRepairOrderForKeys(entitiesDb({ order, estimates: [signed] }), 'shop-1', '', vin), null);
});
