import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import {
  GENERIC_UNLOCK_ERROR,
  RATE_LIMITS,
  handleLicenseAdmin,
  handleLicenses,
  isLicensePath,
  parseLicenseExpiry,
  requireVehicleKeyUnlock,
  signUnlockToken,
} from '../src/licenses.mjs';
import { HttpError } from '../src/http.mjs';
import { authorizePurpose, deviceIdForPublicKey, deviceProofMessage, sha256Hex } from '../../src/shared/license-proof.js';

const SECRET = 'test-license-secret-0123456789abcdef0123456789';
const ORIGIN = 'https://www.shopcrank.com';
const START = Date.parse('2026-10-19T12:00:00Z');
const EXPIRY = '2027-01-31T23:59:59.000Z';
const admin = { shopId: 'platform', role: 'super_admin', userId: 'timothy', email: 'timothy@shopcrank.com' };
const shopAdmin = { shopId: 'high-plains', role: 'admin', userId: 'owner-1', email: 'owner@highplains.test' };
const technician = { shopId: 'high-plains', role: 'technician', userId: 'tech-1', email: 'tech@highplains.test' };

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function makeDevice(label = 'Bay 1 laptop') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const deviceId = await deviceIdForPublicKey(publicKey);
  const sign = async (purpose, subject, signedAt) => base64Url(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(deviceProofMessage({ purpose, subject, signedAt })),
  )));
  return { label, publicKey, deviceId, sign };
}

function harness({ secret = SECRET } = {}) {
  const env = { DB: createD1(), LICENSE_TOKEN_SECRET: secret };
  const clock = { now: START };
  const options = { now: () => clock.now };
  const call = async (handler, context, method, path, body, headers = {}) => {
    const request = new Request(`${ORIGIN}/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const segments = path.split('?')[0].split('/').filter(Boolean);
    try {
      const response = await handler(request, env, context, segments, options);
      const text = await response.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* html */ }
      return { status: response.status, body: parsed, headers: response.headers };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { status: error.status, body: { message: error.message }, headers: new Headers(error.headers || {}) };
    }
  };
  const customer = (context, method, path, body, headers) => call(handleLicenses, context, method, path, body, headers);
  const platform = (method, path, body, context = admin) => call(handleLicenseAdmin, context, method, path, body);
  const issue = async (device, context = technician) => customer(context, 'POST', 'licenses/unlock/issue', {
    publicKey: device.publicKey, deviceId: device.deviceId, label: device.label,
    signedAt: clock.now, signature: await device.sign('issue', device.deviceId, clock.now),
  });
  const redeem = async (device, token, { context = technician, signer = device, deviceId = device.deviceId, ip } = {}) => customer(
    context, 'POST', 'licenses/unlock/redeem',
    { token, deviceId, signedAt: clock.now, signature: await signer.sign('redeem', await sha256Hex(token), clock.now) },
    ip ? { 'CF-Connecting-IP': ip } : {},
  );
  const audit = async () => (await env.DB.prepare('SELECT * FROM license_audit_log ORDER BY created_at, rowid').all()).results;
  return { env, clock, customer, platform, issue, redeem, audit };
}

async function approvedLicense(h, { expiresAt = EXPIRY, maxDevices = 2 } = {}) {
  const submitted = await h.customer(shopAdmin, 'POST', 'licenses/requests', {
    contactName: 'Dana Owner', businessName: 'High Plains Auto', licenseNumber: 'LSID-4471',
    proofDetails: 'NASTF VSP registration LSID-4471, renewed 2026-08-01', requestedDevices: maxDevices,
  });
  assert.equal(submitted.status, 201);
  const approved = await h.platform('POST', `admin/licenses/requests/${submitted.body.request.id}/approve`, { expiresAt, maxDevices });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  return approved.body.license;
}

function claimsOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function assertGenericFailure(result, status = 403) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { message: GENERIC_UNLOCK_ERROR });
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
}

async function lastDenyReason(h) {
  const denied = (await h.audit()).filter(row => row.event === 'token.denied').at(-1);
  return JSON.parse(denied.detail_json).reason;
}

test('valid token: exp equals the admin-set license expiry and redeem enables the capability', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const issued = await h.issue(device);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('Referrer-Policy'), 'no-referrer');
  const claims = claimsOf(issued.body.token);
  assert.equal(claims.exp * 1000, Date.parse(EXPIRY));
  assert.equal(claims.lid, license.id);
  assert.equal(claims.did, device.deviceId);
  assert.equal(claims.scope, 'vehicle_keys');
  assert.equal(claims.tv, 1);
  assert.match(claims.jti, /^[0-9a-f]{32}$/);
  assert.ok(issued.body.unlockUrl.startsWith(`${ORIGIN}/api/licenses/unlock#token=`), 'token travels in the URL fragment');

  const redeemed = await h.redeem(device, issued.body.token);
  assert.equal(redeemed.status, 200);
  assert.deepEqual(
    { unlocked: redeemed.body.unlocked, licenseId: redeemed.body.licenseId, expiresAt: redeemed.body.expiresAt, useCount: redeemed.body.useCount },
    { unlocked: true, licenseId: license.id, expiresAt: EXPIRY, useCount: 1 },
  );
});

test('reused token keeps working and every use is counted and audited', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  for (let use = 1; use <= 3; use += 1) {
    h.clock.now += 60_000;
    const result = await h.redeem(device, token);
    assert.equal(result.status, 200);
    assert.equal(result.body.useCount, use);
  }
  const listed = (await h.platform('GET', 'admin/licenses')).body.licenses.find(item => item.id === license.id);
  assert.equal(listed.useCount, 3);
  assert.equal(listed.lastUsedAt, new Date(h.clock.now).toISOString());
  assert.equal(listed.devices[0].useCount, 3);
  assert.equal((await h.audit()).filter(row => row.event === 'token.redeemed').length, 3);
});

test('expired: a token stops working once the license expiry passes', async () => {
  const h = harness();
  await approvedLicense(h, { expiresAt: '2026-10-20T12:00:00Z' });
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  assert.equal((await h.redeem(device, token)).status, 200);
  h.clock.now = Date.parse('2026-10-20T12:00:01Z');
  assertGenericFailure(await h.redeem(device, token));
  assert.equal(await lastDenyReason(h), 'expired');
  assertGenericFailure(await h.issue(device));
});

test('tampered: edited claims or a forged signature are rejected', async () => {
  const h = harness();
  await approvedLicense(h);
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  const [prefix, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const extended = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 365 * 86400 })).toString('base64url');
  assertGenericFailure(await h.redeem(device, `${prefix}.${extended}.${signature}`));
  assert.equal(await lastDenyReason(h), 'signature');
  const forged = await signUnlockToken('attacker-secret-attacker-secret-attacker', claims);
  assertGenericFailure(await h.redeem(device, forged));
  assert.equal(await lastDenyReason(h), 'signature');
  assertGenericFailure(await h.redeem(device, 'not-a-token'));
});

test('revoked or suspended license blocks redeem and issuance immediately', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  assert.equal((await h.platform('POST', `admin/licenses/${license.id}/suspend`)).status, 200);
  assertGenericFailure(await h.redeem(device, token));
  assert.equal(await lastDenyReason(h), 'license_suspended');
  assertGenericFailure(await h.issue(device));

  assert.equal((await h.platform('POST', `admin/licenses/${license.id}/reactivate`)).status, 200);
  assertGenericFailure(await h.redeem(device, token));
  assert.equal(await lastDenyReason(h), 'token_reissued', 'suspension bumps the token version, so old tokens stay dead');
  const fresh = (await h.issue(device)).body.token;
  assert.equal((await h.redeem(device, fresh)).status, 200, 'reactivation needs a newly issued token');

  assert.equal((await h.platform('POST', `admin/licenses/${license.id}/revoke`)).status, 200);
  assertGenericFailure(await h.redeem(device, fresh));
  assert.equal(await lastDenyReason(h), 'license_revoked');
  assertGenericFailure(await h.issue(device));
  assert.equal((await h.platform('POST', `admin/licenses/${license.id}/reactivate`)).status, 409, 'revoke is final');
});

test('reissue invalidates every outstanding token via the token version claim', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const old = (await h.issue(device)).body.token;
  assert.equal((await h.redeem(device, old)).status, 200);
  const reissued = await h.platform('POST', `admin/licenses/${license.id}/reissue`);
  assert.equal(reissued.body.license.tokenVersion, 2);
  assertGenericFailure(await h.redeem(device, old));
  assert.equal(await lastDenyReason(h), 'token_reissued');
  const replacement = (await h.issue(device)).body.token;
  assert.equal(claimsOf(replacement).tv, 2);
  assert.equal((await h.redeem(device, replacement)).status, 200);
});

test('shortening the expiry shuts off outstanding tokens even though their exp is still in the future', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const old = (await h.issue(device)).body.token;
  const edited = await h.platform('PUT', `admin/licenses/${license.id}`, { expiresAt: '2026-11-30' });
  assert.equal(edited.body.license.expiresAt, '2026-11-30T23:59:59.000Z');
  assertGenericFailure(await h.redeem(device, old));
  assert.equal(await lastDenyReason(h), 'expiry_shortened');
  const replacement = (await h.issue(device)).body.token;
  assert.equal(claimsOf(replacement).exp * 1000, Date.parse('2026-11-30T23:59:59Z'));
  assert.equal((await h.redeem(device, replacement)).status, 200);
});

test('wrong device: another device cannot use a token bound to this one', async () => {
  const h = harness();
  await approvedLicense(h);
  const device = await makeDevice();
  const other = await makeDevice('Stolen laptop');
  const { token } = (await h.issue(device)).body;
  assertGenericFailure(await h.redeem(other, token));
  assert.equal(await lastDenyReason(h), 'device_mismatch');
  assertGenericFailure(await h.redeem(device, token, { signer: other }));
  assert.equal(await lastDenyReason(h), 'device_proof');
  assertGenericFailure(await h.redeem(device, token, { context: { ...technician, shopId: 'other-shop' } }));
  assert.equal(await lastDenyReason(h), 'shop_mismatch');
});

test('device limit, device revocation, and an issue request with a forged device id', async () => {
  const h = harness();
  const license = await approvedLicense(h, { maxDevices: 1 });
  const first = await makeDevice();
  const second = await makeDevice('Second laptop');
  const { token } = (await h.issue(first)).body;
  assertGenericFailure(await h.issue(second));
  const forged = await h.customer(technician, 'POST', 'licenses/unlock/issue', {
    publicKey: second.publicKey, deviceId: first.deviceId, signedAt: h.clock.now, signature: await second.sign('issue', first.deviceId, h.clock.now),
  });
  assertGenericFailure(forged);
  const revoked = await h.platform('POST', `admin/licenses/${license.id}/devices/${encodeURIComponent(first.deviceId)}/revoke`);
  assert.equal(revoked.body.license.activeDevices, 0);
  assertGenericFailure(await h.redeem(first, token));
  assertGenericFailure(await h.issue(first), 403);
  assert.equal((await h.issue(second)).status, 201, 'a freed seat can bind a different device');
});

test('rate limit: redeem and issue return the same generic error with 429', async () => {
  const h = harness();
  await approvedLicense(h);
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  for (let attempt = 1; attempt <= RATE_LIMITS.redeem.limit; attempt += 1) {
    assert.equal((await h.redeem(device, token)).status, 200);
  }
  const limited = await h.redeem(device, token);
  assertGenericFailure(limited, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  h.clock.now += RATE_LIMITS.redeem.windowMs;
  assert.equal((await h.redeem(device, token)).status, 200, 'window resets');

  for (let attempt = 1; attempt < RATE_LIMITS.issue.limit; attempt += 1) await h.issue(device);
  assertGenericFailure(await h.issue(device), 429);
  assert.ok((await h.audit()).some(row => row.event === 'token.rate_limited'));
});

test('GET on the unlock link never redeems, and tokens never reach the audit log', async () => {
  const h = harness();
  const license = await approvedLicense(h);
  const device = await makeDevice();
  const { token, unlockUrl } = (await h.issue(device)).body;
  const landing = await h.customer(technician, 'GET', 'licenses/unlock');
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(landing.headers.get('Content-Type'), /text\/html/);
  assert.match(landing.body, /does not unlock anything/);
  assert.equal(new URL(unlockUrl).search, '', 'no token in the query string');
  const listed = (await h.platform('GET', 'admin/licenses')).body.licenses.find(item => item.id === license.id);
  assert.equal(listed.useCount, 0);
  await h.redeem(device, token);
  await h.redeem(await makeDevice(), token);
  const serialized = JSON.stringify(await h.audit());
  assert.ok(!serialized.includes(token));
  assert.ok(!serialized.includes(token.split('.')[2]));
});

test('live key-programming gate binds the device proof to the procedure and VIN', async () => {
  const h = harness();
  await approvedLicense(h);
  const device = await makeDevice();
  const { token } = (await h.issue(device)).body;
  const vin = '1C6SRFHT0LN123456';
  const request = new Request(`${ORIGIN}/api/diagnostics/authorize`, { method: 'POST' });
  const unlock = async (purpose) => ({
    token, deviceId: device.deviceId, signedAt: h.clock.now, signature: await device.sign(purpose, await sha256Hex(token), h.clock.now),
  });
  const ok = await requireVehicleKeyUnlock(h.env, technician, await unlock(authorizePurpose('add_key', vin)), { procedure: 'add_key', vin, request, nowMs: h.clock.now });
  assert.equal(ok.useCount, 1);
  await assert.rejects(
    requireVehicleKeyUnlock(h.env, technician, await unlock(authorizePurpose('add_key', '1C6SRFHT0LN999999')), { procedure: 'add_key', vin, request, nowMs: h.clock.now }),
    error => error.status === 403 && error.message === GENERIC_UNLOCK_ERROR,
  );
  await assert.rejects(
    requireVehicleKeyUnlock(h.env, technician, undefined, { procedure: 'add_key', vin, request, nowMs: h.clock.now }),
    error => error.status === 403 && error.message === GENERIC_UNLOCK_ERROR,
  );
});

test('admin panel API: owner-only, expiry required at approval, deny, and audit log', async () => {
  const h = harness();
  for (const context of [shopAdmin, technician, { ...shopAdmin, role: 'owner' }]) {
    assert.equal((await h.platform('GET', 'admin/licenses', undefined, context)).status, 403);
  }
  assert.equal((await h.customer({ ...technician, role: 'office' }, 'GET', 'licenses/status')).status, 403);
  assert.equal((await h.customer(technician, 'POST', 'licenses/requests', { contactName: 'x', businessName: 'y', proofDetails: 'long enough proof' })).status, 403);

  const submitted = await h.customer(shopAdmin, 'POST', 'licenses/requests', {
    contactName: 'Dana', businessName: 'High Plains Auto', proofDetails: 'Locksmith license TX-B12345',
    proofFileKey: 'shops/high-plains/license-proof/abc', proofFileName: 'license.pdf',
  });
  const requestId = submitted.body.request.id;
  assert.equal((await h.customer(shopAdmin, 'POST', 'licenses/requests', { contactName: 'Dana', businessName: 'HPA', proofDetails: 'second request' })).status, 409);
  assert.equal((await h.customer(shopAdmin, 'POST', 'licenses/requests', { contactName: 'Dana', businessName: 'HPA', proofDetails: 'other shop file', proofFileKey: 'shops/other/license-proof/x' })).status, 400);
  assert.equal((await h.platform('POST', `admin/licenses/requests/${requestId}/approve`, {})).status, 400);
  assert.equal((await h.platform('POST', `admin/licenses/requests/${requestId}/approve`, { expiresAt: '2020-01-01' })).status, 400);
  const pendingView = (await h.platform('GET', 'admin/licenses')).body.requests[0];
  assert.equal(pendingView.status, 'pending');
  assert.equal(pendingView.proofDetails, 'Locksmith license TX-B12345');
  assert.equal(pendingView.hasProofFile, true);

  const denied = await h.platform('POST', `admin/licenses/requests/${requestId}/deny`, { reason: 'License number not found' });
  assert.equal(denied.body.request.status, 'denied');
  assert.equal((await h.platform('POST', `admin/licenses/requests/${requestId}/approve`, { expiresAt: EXPIRY })).status, 409);
  const status = await h.customer(technician, 'GET', 'licenses/status');
  assert.equal(status.body.license, null);
  assert.equal(status.body.requests[0].decisionNote, 'License number not found');

  const license = await approvedLicense(h);
  assert.equal(license.status, 'active');
  assert.equal(license.expiresAt, EXPIRY);
  const duplicate = await h.platform('POST', 'admin/licenses', { shopId: 'high-plains', customerName: 'HPA', expiresAt: EXPIRY });
  assert.equal(duplicate.status, 409);
  const events = (await h.platform('GET', `admin/licenses/audit?licenseId=${license.id}`)).body.events.map(item => item.event);
  assert.deepEqual(events.sort(), ['license.created', 'request.approved']);
  const all = (await h.platform('GET', 'admin/licenses/audit')).body.events.map(item => item.event);
  for (const event of ['request.submitted', 'request.denied']) assert.ok(all.includes(event));
});

test('unconfigured or short signing secret fails closed', async () => {
  const h = harness({ secret: 'too-short' });
  await approvedLicense(h);
  assertGenericFailure(await h.issue(await makeDevice()));
});

test('expiry parsing and license path detection', () => {
  assert.equal(parseLicenseExpiry('2027-03-01', START), '2027-03-01T23:59:59.000Z');
  assert.equal(parseLicenseExpiry('2027-03-01T08:30:15.987Z', START), '2027-03-01T08:30:15.000Z');
  assert.throws(() => parseLicenseExpiry('', START), /required/);
  assert.throws(() => parseLicenseExpiry('soon', START), /valid date/);
  assert.ok(isLicensePath('/api/licenses/unlock'));
  assert.ok(isLicensePath('/api/admin/licenses/abc/revoke'));
  assert.ok(!isLicensePath('/api/admin/accounts'));
});
