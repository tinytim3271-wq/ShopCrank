import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeUnlock,
  expiryInputValue,
  issueRequestBody,
  keyLicensePanelHtml,
  licenseAdminHtml,
  parseUnlockInput,
  redeemRequestBody,
  requiresVehicleKeyLicense,
  storedUnlockState,
  unlockTokenClaims,
} from './vehicle-key-license.js';
import { escapeHtml } from '../shared/html.js';
import { authorizePurpose, deviceIdForPublicKey, sha256Hex } from '../shared/license-proof.js';
import { verifyDeviceProof } from '../../worker/src/licenses.mjs';

const helpers = { escapeHtml, icon: name => `<i data-lucide="${name}"></i>` };
const future = new Date(Date.now() + 30 * 86400000);
const expSeconds = Math.floor(future.getTime() / 1000);

function fakeToken(claims) {
  return `sck1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2lnbmF0dXJl`;
}

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  return { privateKey: pair.privateKey, publicKey, deviceId: await deviceIdForPublicKey(publicKey) };
}

const license = {
  id: 'lic-1', status: 'active', expired: false, expiresAt: new Date(expSeconds * 1000).toISOString(),
  maxDevices: 2, activeDevices: 1, tokenVersion: 3, thisDevice: { status: 'active' },
};

test('only live key procedures need the license unlock', () => {
  assert.equal(requiresVehicleKeyLicense({ mode: 'live', procedure: 'add_key' }), true);
  assert.equal(requiresVehicleKeyLicense({ mode: 'live', procedure: 'program_remote' }), true);
  assert.equal(requiresVehicleKeyLicense({ mode: 'simulate', procedure: 'add_key' }), false);
  assert.equal(requiresVehicleKeyLicense({ mode: 'live', procedure: 'clear_dtcs' }), false);
});

test('parseUnlockInput reads the token from the URL fragment or a bare token', () => {
  const token = fakeToken({ lid: 'lic-1' });
  assert.equal(parseUnlockInput(`https://www.shopcrank.com/api/licenses/unlock#token=${encodeURIComponent(token)}`), token);
  assert.equal(parseUnlockInput(`  ${token} `), token);
  assert.equal(parseUnlockInput('https://evil.example/#token=<script>'), null);
  assert.equal(parseUnlockInput(''), null);
  assert.equal(unlockTokenClaims(token).lid, 'lic-1');
});

test('storedUnlockState tracks reissue, shortened expiry, and device removal', () => {
  const deviceId = 'dev-1';
  const claims = { lid: 'lic-1', did: deviceId, tv: 3, exp: expSeconds };
  const stored = { token: fakeToken(claims), redeemedAt: '2026-10-19T12:00:00Z' };
  assert.equal(storedUnlockState(null, license, deviceId), 'none');
  assert.equal(storedUnlockState(stored, license, deviceId), 'unlocked');
  assert.equal(storedUnlockState({ token: stored.token }, license, deviceId), 'issued');
  assert.equal(storedUnlockState(stored, { ...license, tokenVersion: 4 }, deviceId), 'stale');
  assert.equal(storedUnlockState(stored, { ...license, expiresAt: new Date(Date.now() + 86400000).toISOString() }, deviceId), 'stale');
  assert.equal(storedUnlockState(stored, { ...license, status: 'suspended' }, deviceId), 'blocked');
  assert.equal(storedUnlockState(stored, { ...license, thisDevice: { status: 'revoked' } }, deviceId), 'blocked');
  assert.equal(storedUnlockState(stored, license, 'other-device'), 'stale');
});

test('device proofs signed by the key app verify in the Worker', async () => {
  const device = await identity();
  const token = fakeToken({ lid: 'lic-1' });
  const issue = await issueRequestBody(device, 'Bay laptop');
  assert.equal(issue.deviceId, device.deviceId);
  assert.ok(await verifyDeviceProof(device.publicKey, { purpose: 'issue', subject: device.deviceId, signedAt: issue.signedAt, signature: issue.signature }));
  const redeem = await redeemRequestBody(device, token);
  assert.ok(await verifyDeviceProof(device.publicKey, { purpose: 'redeem', subject: await sha256Hex(token), signedAt: redeem.signedAt, signature: redeem.signature }));
  const authorize = await authorizeUnlock(device, token, 'add_key', '1c6srfht0ln123456');
  const purpose = authorizePurpose('add_key', '1C6SRFHT0LN123456');
  assert.ok(authorize.nonce);
  assert.ok(await verifyDeviceProof(device.publicKey, {
    purpose, subject: await sha256Hex(token), signedAt: authorize.signedAt, signature: authorize.signature, nonce: authorize.nonce,
  }));
  assert.equal(await verifyDeviceProof(device.publicKey, {
    purpose, subject: await sha256Hex(token), signedAt: authorize.signedAt, signature: authorize.signature,
  }), false);
  assert.equal(await verifyDeviceProof(device.publicKey, { purpose: 'redeem', subject: await sha256Hex(token), signedAt: authorize.signedAt, signature: authorize.signature }), false);
});

test('key app panel covers request, review, unlock, and locked states', () => {
  const requestForm = keyLicensePanelHtml({ status: { license: null, requests: [], canRequest: true } }, helpers);
  assert.match(requestForm, /id="key-license-request-form"/);
  assert.match(requestForm, /name="proofFile"/);
  const techView = keyLicensePanelHtml({ status: { license: null, requests: [], canRequest: false } }, helpers);
  assert.doesNotMatch(techView, /key-license-request-form/);
  const pending = keyLicensePanelHtml({ status: { license: null, requests: [{ status: 'pending', businessName: '<b>HPA</b>', createdAt: '2026-10-19T00:00:00Z' }] } }, helpers);
  assert.match(pending, /Request under review/);
  assert.match(pending, /&lt;b&gt;HPA&lt;\/b&gt;/);
  assert.match(pending, /id="key-license-refresh"/);
  const denied = keyLicensePanelHtml({ status: { license: null, canRequest: true, requests: [{ status: 'denied', decisionNote: 'Expired proof' }] } }, helpers);
  assert.match(denied, /Expired proof/);
  assert.match(keyLicensePanelHtml({ status: { license }, unlockState: 'none' }, helpers), /id="key-license-issue"/);
  const issued = keyLicensePanelHtml({ status: { license }, unlockState: 'issued', unlockUrl: 'https://x/#token=abc' }, helpers);
  assert.match(issued, /id="key-license-redeem"/);
  assert.match(issued, /Opening the link does nothing by itself/);
  assert.match(keyLicensePanelHtml({ status: { license }, unlockState: 'unlocked' }, helpers), /This device is unlocked/);
  assert.match(keyLicensePanelHtml({ status: { license }, unlockState: 'unlocked' }, helpers), /id="key-license-refresh"/);
  assert.match(keyLicensePanelHtml({ status: { license: { ...license, status: 'suspended' } } }, helpers), /locked/);
  assert.match(keyLicensePanelHtml({ status: { license: { ...license, status: 'revoked' }, requests: [], canRequest: true } }, helpers), /License revoked/);
});

test('admin Licenses section lists requests, licenses with use counts, and audit events', () => {
  const html = licenseAdminHtml({
    requests: [{ id: 'req-1', status: 'pending', shopId: 'hpa', businessName: 'HPA', contactName: 'Dana', requesterEmail: 'd@hpa.test', proofDetails: 'LSID <1>', hasProofFile: true, proofFileName: 'proof.pdf', requestedDevices: 2, createdAt: '2026-10-19T00:00:00Z' }],
    licenses: [{ ...license, shopId: 'hpa', customerName: 'HPA', useCount: 7, lastUsedAt: '2026-10-19T13:00:00Z', devices: [{ deviceId: 'abcdefghijklmnop', label: 'Bay', status: 'active', useCount: 7 }] }],
    events: [{ createdAt: '2026-10-19T13:00:00Z', event: 'token.redeemed', shopId: 'hpa', licenseId: 'lic-1', deviceId: 'abcdefghijkl', actorEmail: 'tech@hpa.test', detail: { useCount: 7 } }],
  }, helpers);
  for (const marker of ['data-license-approve="req-1"', 'data-license-deny="req-1"', 'data-license-proof="req-1"', 'data-license-edit="lic-1"',
    'data-license-action="suspend"', 'data-license-action="reissue"', 'data-license-action="revoke"', 'data-license-device-revoke="lic-1"', 'data-license-audit="lic-1"', 'token.redeemed']) {
    assert.ok(html.includes(marker), marker);
  }
  assert.match(html, /<b>7<\/b><small>Last /);
  assert.match(html, /Token v3/);
  assert.match(html, /LSID &lt;1&gt;/);
  assert.equal(expiryInputValue('2027-01-31T23:59:59.000Z'), '2027-01-31');
});
