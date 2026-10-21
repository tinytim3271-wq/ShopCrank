import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { GENERIC_UNLOCK_ERROR } from '../src/licenses.mjs';
import { authorizePurpose, deviceIdForPublicKey, deviceProofMessage, sha256Hex } from '../../src/shared/license-proof.js';

const VIN = '1C6SRFHT0LN123456';
const OWNER = 'timothy@shopcrank.com';

async function setup() {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.sqlite.exec(`
    INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, created_at, updated_at, created_by)
      VALUES ('high-plains', 'High Plains Auto', 'owner@hpa.test', 'Dana', '${now}', '${now}', 'test');
    INSERT INTO shops (id, name, slug, created_at, updated_at) VALUES ('high-plains', 'High Plains Auto', 'high-plains', '${now}', '${now}');
    INSERT INTO subscriptions (shop_id, plan_id, status, updated_at) VALUES ('high-plains', 'shop_pro', 'active', '${now}');
    INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES
      ('owner@hpa.test', 'high-plains', 'admin', 'Dana', '${now}', '${now}'),
      ('tech@hpa.test', 'high-plains', 'technician', 'Sam', '${now}', '${now}');
  `);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    ACCESS_ADMIN_EMAILS: OWNER,
    LICENSE_TOKEN_SECRET: 'e2e-license-secret-0123456789abcdef0123456789',
    INTEGRATION_ENCRYPTION_KEY: 'e2e-integration-key-0123456789',
    DIAGNOSTICS_SIGNING_PRIVATE_KEY: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'),
    FILES: { head: async () => ({ httpMetadata: { contentType: 'image/png' } }) },
  };
  DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('high-plains', 'orders', 'RO-1', JSON.stringify({
      id: 'RO-1', vin: VIN, linesLockedAt: now,
      estimateApproval: {
        status: 'approved', type: 'signature', authorizationName: 'Dana Customer', signedAt: now,
        signatureKey: 'shops/high-plains/signatures/ro-1.png',
      },
    }), 'owner-1', now, now).runSync();
  DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('high-plains', 'orders', 'RO-UNSIGNED', JSON.stringify({
      id: 'RO-UNSIGNED', vin: VIN, linesLockedAt: now,
<<<<<<< Updated upstream
        estimateApproval: { status: 'approved', type: 'other', authorizationName: 'Dana Customer' },
=======
      estimateApproval: { status: 'approved', type: 'other', authorizationName: 'Dana Customer' },
>>>>>>> Stashed changes
    }), 'owner-1', now, now).runSync();
  const call = async (email, method, path, body) => {
    const response = await worker.fetch(new Request(`https://www.shopcrank.com/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': email, 'CF-Connecting-IP': '198.51.100.4' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, {});
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* html */ }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { env, call };
}

async function makeDevice() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const deviceId = await deviceIdForPublicKey(publicKey);
  const sign = async (purpose, subject, signedAt, nonce) => Buffer.from(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(deviceProofMessage({ purpose, subject, signedAt, nonce })),
  )).toString('base64url');
  return { publicKey, deviceId, sign };
}

test('end to end through the Worker: request, approve, issue, live key authorize, revoke', async () => {
<<<<<<< Updated upstream
  const { call } = await setup();
=======
  const { env, call } = await setup();
>>>>>>> Stashed changes
  const connect = await call('owner@hpa.test', 'POST', '/diagnostics/autoauth', { accountId: 'hpa', apiKey: 'test-key' });
  assert.equal(connect.status, 201);

  const submitted = await call('owner@hpa.test', 'POST', '/licenses/requests', {
    contactName: 'Dana', businessName: 'High Plains Auto', proofDetails: 'NASTF VSP LSID-4471', requestedDevices: 1,
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await call('owner@hpa.test', 'GET', '/admin/licenses')).status, 403, 'shop admins cannot reach the license console');

  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const approved = await call(OWNER, 'POST', `/admin/licenses/requests/${submitted.body.request.id}/approve`, { expiresAt });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  const licenseId = approved.body.license.id;

  const device = await makeDevice();
  const signedAt = Date.now();
  const issued = await call('tech@hpa.test', 'POST', '/licenses/unlock/issue', {
    publicKey: device.publicKey, deviceId: device.deviceId, signedAt, signature: await device.sign('issue', device.deviceId, signedAt),
  });
  assert.equal(issued.status, 201);
  const { token } = issued.body;

  const landing = await call('tech@hpa.test', 'GET', '/licenses/unlock');
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer');

  const authorize = async (licenseUnlock, orderId = 'RO-1') => call('tech@hpa.test', 'POST', '/diagnostics/authorize', {
    vin: VIN, procedure: 'add_key', mode: 'live', orderId, licenseUnlock,
  });
  const unlock = async () => {
    const at = Date.now();
    const nonce = crypto.randomUUID();
    return {
      token, deviceId: device.deviceId, signedAt: at, nonce,
      signature: await device.sign(authorizePurpose('add_key', VIN), await sha256Hex(token), at, nonce),
    };
  };
  const missingOrder = await authorize(await unlock(), 'RO-MISSING');
  assert.equal(missingOrder.status, 403);
  assert.match(missingOrder.body.message, /signed repair order/);
  const unsignedOrder = await authorize(await unlock(), 'RO-UNSIGNED');
  assert.equal(unsignedOrder.status, 403);
  assert.match(unsignedOrder.body.message, /signed repair order/);

  const missing = await authorize(undefined);
  assert.equal(missing.status, 403);
  assert.equal(missing.body.message, GENERIC_UNLOCK_ERROR);
  assert.equal(missing.headers.get('Referrer-Policy'), 'no-referrer');

  const first = await authorize(await unlock());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.authorized, true);
<<<<<<< Updated upstream
=======

  // Regression (Bug 1): the diagnostics audit record must carry the signed
  // repair order that authorized this job — orderId, authorizationName and
  // signedAt come from the signedOrder validated before token minting.
  const auditRows = env.DB.sqlite.prepare(
    "SELECT event_json FROM audit_log WHERE shop_id = 'high-plains'",
  ).all().map(row => JSON.parse(row.event_json));
  const authorizeAudit = auditRows.find(event => event.kind === 'diagnostics.authorize');
  assert.ok(authorizeAudit, 'diagnostics.authorize audit row recorded');
  assert.equal(authorizeAudit.orderId, 'RO-1');
  assert.equal(authorizeAudit.authorizationName, 'Dana Customer');
  assert.ok(Number.isFinite(Date.parse(authorizeAudit.signedAt)), 'audit signedAt is the order approval time');

>>>>>>> Stashed changes
  const second = await authorize(await unlock());
  assert.equal(second.status, 200, 'the same unlock token works for every job until expiry');

  const simulate = await call('tech@hpa.test', 'POST', '/diagnostics/authorize', { vin: VIN, procedure: 'add_key', mode: 'simulate' });
  assert.equal(simulate.status, 200, 'bench simulator stays available without a license');

  const listed = (await call(OWNER, 'GET', '/admin/licenses')).body.licenses.find(item => item.id === licenseId);
  assert.equal(listed.useCount, 2);

  assert.equal((await call(OWNER, 'POST', `/admin/licenses/${licenseId}/revoke`)).status, 200);
  const afterRevoke = await authorize(await unlock());
  assert.equal(afterRevoke.status, 403);
  assert.equal(afterRevoke.body.message, GENERIC_UNLOCK_ERROR);

  const auditEvents = (await call(OWNER, 'GET', `/admin/licenses/audit?licenseId=${licenseId}`)).body.events.map(item => item.event);
  for (const event of ['license.created', 'token.issued', 'token.redeemed', 'license.revoked', 'token.denied']) {
    assert.ok(auditEvents.includes(event), `${event} recorded`);
  }
});
