import { HttpError, json, requestJson } from './http.mjs';
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hmacBase64Url } from './security.mjs';
import {
  authorizePurpose,
  DEVICE_PROOF_MAX_SKEW_MS,
  deviceIdForPublicKey,
  deviceProofMessage,
  sha256Hex,
} from '../../src/shared/license-proof.js';

/**
 * Vehicle key licensing. The platform owner approves a license with an
 * explicit expiry; licensed devices receive a signed unlock token whose exp
 * claim is that expiry. Tokens are reusable, but every use is re-checked live
 * against D1 (status, expiry, token version, device binding), so suspend,
 * revoke, reissue, a shortened expiry, or a revoked device take effect at once.
 */

export const LICENSE_SCOPE = 'vehicle_keys';
export const TOKEN_PREFIX = 'sck1';
export const TOKEN_TYPE = 'shopcrank.vehicle_keys.unlock';
export const GENERIC_UNLOCK_ERROR = 'This unlock request could not be completed.';
export const RATE_LIMITS = {
  issue: { limit: 10, windowMs: 15 * 60 * 1000 },
  redeem: { limit: 30, windowMs: 5 * 60 * 1000 },
};
const MIN_SECRET_LENGTH = 32;
const MAX_LICENSE_TERM_MS = 10 * 366 * 86400000;
const KEY_ROLES = ['owner', 'admin', 'technician', 'service_writer'];
const REQUEST_ROLES = ['owner', 'admin'];
const NO_REFERRER = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const encoder = new TextEncoder();

function licenseJson(body, status = 200) {
  return json(body, status, NO_REFERRER);
}

function unlockError(status = 403, headers = {}) {
  return new HttpError(status, GENERIC_UNLOCK_ERROR, { ...NO_REFERRER, ...headers });
}

function requireLicenseRole(context, roles) {
  if (!roles.includes(context.role)) throw new HttpError(403, `Role ${context.role} is not permitted for this action`);
}

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function signingSecret(env) {
  const secret = String(env.LICENSE_TOKEN_SECRET || '');
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function nowFn(options) {
  return typeof options?.now === 'function' ? options.now : Date.now;
}

export function isLicensePath(pathname) {
  return /^\/api\/(?:admin\/)?licenses(?:\/|$)/.test(String(pathname || ''));
}

/** Date-only input means end of that day (UTC). Stored with whole seconds so exp === expiry. */
export function parseLicenseExpiry(value, nowMs = Date.now()) {
  const raw = cleanText(value, 40);
  if (!raw) throw new HttpError(400, 'An expiration date is required');
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59Z` : raw);
  if (!Number.isFinite(ms)) throw new HttpError(400, 'expiresAt must be a valid date');
  const wholeSeconds = Math.floor(ms / 1000) * 1000;
  if (wholeSeconds <= nowMs) throw new HttpError(400, 'The expiration date must be in the future');
  // Also keeps expires_at a fixed-width ISO string, which the SQL comparisons rely on.
  if (wholeSeconds > nowMs + MAX_LICENSE_TERM_MS) throw new HttpError(400, 'The expiration date must be within 10 years');
  return new Date(wholeSeconds).toISOString();
}

function parseDeviceCount(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new HttpError(400, 'Device count must be a whole number from 1 to 100');
  return count;
}

const SENSITIVE_DETAIL_KEYS = /^(?:token|unlockurl|signature|secret|publickey)$/i;

export async function recordLicenseAudit(env, event, fields = {}, nowMs = Date.now()) {
  const detail = Object.fromEntries(Object.entries(fields.detail || {})
    .filter(([key, value]) => value !== undefined && !SENSITIVE_DETAIL_KEYS.test(key)));
  await env.DB.prepare(`
    INSERT INTO license_audit_log (id, event, license_id, request_id, shop_id, device_id, jti, actor_id, actor_email, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `lic-audit-${nowMs}-${crypto.randomUUID()}`,
    event,
    fields.licenseId || null,
    fields.requestId || null,
    fields.shopId || null,
    fields.deviceId || null,
    fields.jti || null,
    fields.actor?.userId || null,
    fields.actor?.email || null,
    JSON.stringify(detail),
    new Date(nowMs).toISOString(),
  ).run();
}

export async function enforceLicenseRateLimit(env, bucket, { limit, windowMs }, nowMs = Date.now()) {
  const row = await env.DB.prepare(`
    INSERT INTO license_rate_limits (bucket, window_start, request_count) VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET
      window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END,
      request_count = CASE WHEN ? - window_start >= ? THEN 1 ELSE request_count + 1 END
    RETURNING request_count
  `).bind(bucket, nowMs, nowMs, windowMs, nowMs, nowMs, windowMs).first();
  return Number(row?.request_count || 0) <= limit;
}

async function enforceUnlockRateLimits(env, request, context, action, nowMs) {
  const rule = RATE_LIMITS[action];
  const ip = request?.headers?.get('CF-Connecting-IP') || 'unknown';
  const userOk = await enforceLicenseRateLimit(env, `${action}:user:${context.shopId}:${context.userId}`, rule, nowMs);
  const ipOk = await enforceLicenseRateLimit(env, `${action}:ip:${ip}`, rule, nowMs);
  if (userOk && ipOk) return;
  await recordLicenseAudit(env, 'token.rate_limited', {
    shopId: context.shopId, actor: context, detail: { action },
  }, nowMs);
  throw unlockError(429, { 'Retry-After': String(Math.ceil(rule.windowMs / 1000)) });
}

export async function signUnlockToken(secret, claims) {
  const signingInput = `${TOKEN_PREFIX}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
  return `${signingInput}.${await hmacBase64Url(secret, signingInput)}`;
}

/** Verifies signature, shape, and the exp claim. Never throws; returns a reason for the audit log. */
export async function verifyUnlockTokenSignature(secret, token, nowMs = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const expected = await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`);
  if (!constantTimeEqual(expected, parts[2])) return { ok: false, reason: 'signature' };
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const integers = ['tv', 'iat', 'exp'].every(key => Number.isInteger(claims?.[key]));
  const strings = ['lid', 'sid', 'did', 'jti'].every(key => typeof claims?.[key] === 'string' && claims[key]);
  if (claims?.v !== 1 || claims.typ !== TOKEN_TYPE || claims.scope !== LICENSE_SCOPE || !integers || !strings) {
    return { ok: false, reason: 'claims' };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'expired', claims };
  if (claims.iat * 1000 > nowMs + 60_000) return { ok: false, reason: 'issued_in_future', claims };
  return { ok: true, claims };
}

export async function verifyDeviceProof(publicKeyBase64, { purpose, subject, signedAt, signature }, nowMs = Date.now()) {
  const at = Number(signedAt);
  if (!Number.isFinite(at) || Math.abs(nowMs - at) > DEVICE_PROOF_MAX_SKEW_MS || !signature) return false;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(String(publicKeyBase64)), character => character.charCodeAt(0)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlDecode(String(signature)),
      encoder.encode(deviceProofMessage({ purpose, subject, signedAt: at })),
    );
  } catch {
    return false;
  }
}

async function currentLicenseForShop(env, shopId) {
  return env.DB.prepare(`
    SELECT * FROM licenses WHERE shop_id = ?
    ORDER BY CASE WHEN status = 'revoked' THEN 1 ELSE 0 END, created_at DESC LIMIT 1
  `).bind(shopId).first();
}

async function licenseDevices(env, licenseId) {
  const { results = [] } = await env.DB.prepare(
    'SELECT device_id, label, status, bound_at, revoked_at, use_count, last_used_at FROM license_devices WHERE license_id = ? ORDER BY bound_at',
  ).bind(licenseId).all();
  return results.map(row => ({
    deviceId: row.device_id,
    label: row.label || '',
    status: row.status,
    boundAt: row.bound_at,
    revokedAt: row.revoked_at || null,
    useCount: Number(row.use_count || 0),
    lastUsedAt: row.last_used_at || null,
  }));
}

function licenseView(row, devices = []) {
  if (!row) return null;
  return {
    id: row.id,
    shopId: row.shop_id,
    customerName: row.customer_name,
    status: row.status,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.now(),
    maxDevices: Number(row.max_devices),
    tokenVersion: Number(row.token_version),
    useCount: Number(row.use_count || 0),
    lastUsedAt: row.last_used_at || null,
    notes: row.notes || '',
    requestId: row.request_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at || null,
    revokedAt: row.revoked_at || null,
    devices,
    activeDevices: devices.filter(device => device.status === 'active').length,
  };
}

function requestView(row, { admin = false } = {}) {
  return {
    id: row.id,
    shopId: row.shop_id,
    status: row.status,
    businessName: row.business_name,
    contactName: row.contact_name,
    requestedDevices: Number(row.requested_devices),
    decisionNote: row.decision_note || '',
    decidedAt: row.decided_at || null,
    licenseId: row.license_id || null,
    createdAt: row.created_at,
    ...(admin ? {
      requesterEmail: row.requester_email,
      licenseNumber: row.license_number || '',
      proofDetails: row.proof_details,
      hasProofFile: Boolean(row.proof_file_key),
      proofFileName: row.proof_file_name || '',
      decidedBy: row.decided_by || null,
    } : {}),
  };
}

/**
 * Core check used by both the explicit redeem endpoint and the live
 * key-programming authorize gate. Every failure throws the same generic error;
 * the specific reason only goes to the admin audit log.
 */
export async function redeemUnlockToken(env, context, input, { purpose, nowMs = Date.now() }) {
  const token = String(input?.token || '');
  const deviceId = cleanText(input?.deviceId, 80);
  let claims = null;
  const deny = async (reason) => {
    await recordLicenseAudit(env, 'token.denied', {
      licenseId: claims?.lid, shopId: context.shopId, deviceId: deviceId || null, jti: claims?.jti,
      actor: context, detail: { reason, purpose: String(purpose).split(':')[0] },
    }, nowMs);
    throw unlockError();
  };
  const secret = signingSecret(env);
  if (!secret) return deny('not_configured');
  const verified = await verifyUnlockTokenSignature(secret, token, nowMs);
  claims = verified.claims || null;
  if (!verified.ok) return deny(verified.reason);
  if (claims.sid !== context.shopId) return deny('shop_mismatch');
  if (!deviceId || deviceId !== claims.did) return deny('device_mismatch');
  const device = await env.DB.prepare(
    'SELECT public_key, status FROM license_devices WHERE license_id = ? AND device_id = ?',
  ).bind(claims.lid, deviceId).first();
  if (!device || device.status !== 'active') return deny('device_not_bound');
  const proofOk = await verifyDeviceProof(device.public_key, {
    purpose, subject: await sha256Hex(token), signedAt: input?.signedAt, signature: input?.signature,
  }, nowMs);
  if (!proofOk) return deny('device_proof');
  const nowIso = new Date(nowMs).toISOString();
  // Single statement: the live license state is checked and the use counted together.
  const used = await env.DB.prepare(`
    UPDATE licenses SET use_count = use_count + 1, last_used_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'active'
      AND expires_at > ? AND expires_at >= ? AND token_version = ?
      AND EXISTS (
        SELECT 1 FROM license_devices
        WHERE license_devices.license_id = licenses.id AND device_id = ? AND status = 'active'
      )
    RETURNING use_count, expires_at
  `).bind(
    nowIso, claims.lid, context.shopId, nowIso, new Date(claims.exp * 1000).toISOString(), claims.tv, deviceId,
  ).first();
  if (!used) {
    const license = await env.DB.prepare('SELECT status, expires_at, token_version FROM licenses WHERE id = ?').bind(claims.lid).first();
    if (!license) return deny('license_missing');
    if (license.status !== 'active') return deny(`license_${license.status}`);
    if (license.expires_at <= nowIso) return deny('license_expired');
    if (Number(license.token_version) !== claims.tv) return deny('token_reissued');
    if (Date.parse(license.expires_at) < claims.exp * 1000) return deny('expiry_shortened');
    return deny('device_not_bound');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE license_devices SET use_count = use_count + 1, last_used_at = ? WHERE license_id = ? AND device_id = ?')
      .bind(nowIso, claims.lid, deviceId),
    env.DB.prepare('UPDATE license_tokens SET use_count = use_count + 1, last_used_at = ? WHERE jti = ?')
      .bind(nowIso, claims.jti),
  ]);
  const useCount = Number(used.use_count);
  await recordLicenseAudit(env, 'token.redeemed', {
    licenseId: claims.lid, shopId: context.shopId, deviceId, jti: claims.jti, actor: context,
    detail: { purpose: String(purpose).split(':')[0], procedure: String(purpose).split(':')[1], useCount },
  }, nowMs);
  return { licenseId: claims.lid, deviceId, expiresAt: used.expires_at, useCount };
}

/** Server-side gate for live key programming in POST /api/diagnostics/authorize. */
export async function requireVehicleKeyUnlock(env, context, unlock, { procedure, vin, request, nowMs = Date.now() }) {
  await enforceUnlockRateLimits(env, request, context, 'redeem', nowMs);
  return redeemUnlockToken(env, context, unlock, { purpose: authorizePurpose(procedure, vin), nowMs });
}

async function issueUnlockToken(request, env, context, nowMs) {
  await enforceUnlockRateLimits(env, request, context, 'issue', nowMs);
  const body = await requestJson(request);
  const publicKey = String(body.publicKey || '').trim();
  const nowIso = new Date(nowMs).toISOString();
  let deviceId = null;
  let license = null;
  const deny = async (reason) => {
    await recordLicenseAudit(env, 'token.issue_denied', {
      licenseId: license?.id, shopId: context.shopId, deviceId, actor: context, detail: { reason },
    }, nowMs);
    throw unlockError();
  };
  const secret = signingSecret(env);
  if (!secret) return deny('not_configured');
  try { deviceId = await deviceIdForPublicKey(publicKey); } catch { return deny('device_key'); }
  if (!publicKey || deviceId !== String(body.deviceId || '')) return deny('device_id_mismatch');
  const proofOk = await verifyDeviceProof(publicKey, {
    purpose: 'issue', subject: deviceId, signedAt: body.signedAt, signature: body.signature,
  }, nowMs);
  if (!proofOk) return deny('device_proof');
  license = await env.DB.prepare(
    "SELECT * FROM licenses WHERE shop_id = ? AND status = 'active' AND expires_at > ? LIMIT 1",
  ).bind(context.shopId, nowIso).first();
  if (!license) return deny('no_active_license');
  const device = await env.DB.prepare(
    'SELECT public_key, status FROM license_devices WHERE license_id = ? AND device_id = ?',
  ).bind(license.id, deviceId).first();
  if (device && (device.status !== 'active' || device.public_key !== publicKey)) return deny('device_revoked');
  if (!device) {
    const bound = await env.DB.prepare(`
      INSERT INTO license_devices (license_id, device_id, public_key, label, status, bound_at, bound_by)
      SELECT ?, ?, ?, ?, 'active', ?, ?
      WHERE (SELECT COUNT(*) FROM license_devices WHERE license_id = ? AND status = 'active')
        < (SELECT max_devices FROM licenses WHERE id = ?)
    `).bind(license.id, deviceId, publicKey, cleanText(body.label, 80) || null, nowIso, context.userId, license.id, license.id).run();
    if (Number(bound?.meta?.changes || 0) !== 1) return deny('device_limit');
    await recordLicenseAudit(env, 'device.bound', {
      licenseId: license.id, shopId: context.shopId, deviceId, actor: context, detail: { label: cleanText(body.label, 80) },
    }, nowMs);
  }
  const claims = {
    v: 1,
    typ: TOKEN_TYPE,
    scope: LICENSE_SCOPE,
    lid: license.id,
    sid: context.shopId,
    did: deviceId,
    tv: Number(license.token_version),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(Date.parse(license.expires_at) / 1000),
    jti: crypto.randomUUID().replaceAll('-', ''),
  };
  const token = await signUnlockToken(secret, claims);
  await env.DB.prepare(`
    INSERT INTO license_tokens (jti, license_id, device_id, token_version, issued_at, expires_at, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(claims.jti, license.id, deviceId, claims.tv, nowIso, license.expires_at, context.userId).run();
  await recordLicenseAudit(env, 'token.issued', {
    licenseId: license.id, shopId: context.shopId, deviceId, jti: claims.jti, actor: context,
    detail: { exp: license.expires_at, tokenVersion: claims.tv },
  }, nowMs);
  const unlockUrl = `${new URL(request.url).origin}/api/licenses/unlock#token=${encodeURIComponent(token)}`;
  return licenseJson({
    token, unlockUrl, licenseId: license.id, deviceId, expiresAt: license.expires_at, tokenVersion: claims.tv,
  }, 201);
}

async function submitLicenseRequest(request, env, context, nowMs) {
  requireLicenseRole(context, REQUEST_ROLES);
  const body = await requestJson(request);
  const contactName = cleanText(body.contactName, 120);
  const businessName = cleanText(body.businessName, 160);
  const proofDetails = cleanText(body.proofDetails, 4000);
  const licenseNumber = cleanText(body.licenseNumber, 120);
  const proofFileKey = cleanText(body.proofFileKey, 300);
  if (!contactName || !businessName) throw new HttpError(400, 'Contact name and business name are required');
  if (proofDetails.length < 10) throw new HttpError(400, 'Describe your licensing proof (at least 10 characters)');
  if (proofFileKey && !proofFileKey.startsWith(`shops/${context.shopId}/license-proof/`)) {
    throw new HttpError(400, 'The proof file must be uploaded from this shop');
  }
  const requestedDevices = parseDeviceCount(body.requestedDevices, 1);
  const pending = await env.DB.prepare(
    "SELECT id FROM license_requests WHERE shop_id = ? AND status = 'pending' LIMIT 1",
  ).bind(context.shopId).first();
  if (pending) throw new HttpError(409, 'This shop already has a license request waiting for review');
  const id = `licreq-${crypto.randomUUID()}`;
  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO license_requests (id, shop_id, requested_by, requester_email, contact_name, business_name, license_number,
      proof_details, proof_file_key, proof_file_name, requested_devices, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(
    id, context.shopId, context.userId, context.email || '', contactName, businessName, licenseNumber || null,
    proofDetails, proofFileKey || null, cleanText(body.proofFileName, 160) || null, requestedDevices, nowIso, nowIso,
  ).run();
  await recordLicenseAudit(env, 'request.submitted', {
    requestId: id, shopId: context.shopId, actor: context, detail: { requestedDevices, hasProofFile: Boolean(proofFileKey) },
  }, nowMs);
  const row = await env.DB.prepare('SELECT * FROM license_requests WHERE id = ?').bind(id).first();
  return licenseJson({ request: requestView(row) }, 201);
}

async function licenseStatus(request, env, context) {
  const deviceId = cleanText(new URL(request.url).searchParams.get('deviceId'), 80);
  const row = await currentLicenseForShop(env, context.shopId);
  const devices = row ? await licenseDevices(env, row.id) : [];
  const license = licenseView(row, devices);
  const thisDevice = devices.find(device => device.deviceId === deviceId) || null;
  const { results = [] } = await env.DB.prepare(
    'SELECT * FROM license_requests WHERE shop_id = ? ORDER BY created_at DESC LIMIT 20',
  ).bind(context.shopId).all();
  return licenseJson({
    license: license && {
      id: license.id,
      status: license.status,
      expiresAt: license.expiresAt,
      expired: license.expired,
      maxDevices: license.maxDevices,
      activeDevices: license.activeDevices,
      tokenVersion: license.tokenVersion,
      thisDevice: thisDevice && { status: thisDevice.status, boundAt: thisDevice.boundAt, lastUsedAt: thisDevice.lastUsedAt },
    },
    requests: results.map(item => requestView(item)),
    canRequest: REQUEST_ROLES.includes(context.role),
  });
}

/** GET never redeems: the token sits in the URL fragment, which browsers do not send. */
export function unlockLandingPage() {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShopCrank key unlock</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1f2933}code{background:#eef2f6;padding:.1rem .3rem;border-radius:4px}</style></head><body><h1>ShopCrank vehicle key unlock</h1><p>Opening this link does not unlock anything.</p><p>On the licensed computer, open ShopCrank, go to <b>Key programming</b>, paste this link into <b>Redeem unlock link</b>, and press <b>Unlock this device</b>.</p><p>The link only works on the device it was issued to.</p></body></html>';
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Robots-Tag': 'noindex',
      ...NO_REFERRER,
    },
  });
}

/** Customer side (/api/licenses/*). */
export async function handleLicenses(request, env, context, segments, options = {}) {
  const nowMs = nowFn(options)();
  const action = segments.slice(1).join('/');
  if (action === 'unlock' && request.method === 'GET') return unlockLandingPage();
  requireLicenseRole(context, KEY_ROLES);
  if (action === 'status' && request.method === 'GET') return licenseStatus(request, env, context);
  if (action === 'requests' && request.method === 'POST') return submitLicenseRequest(request, env, context, nowMs);
  if (action === 'unlock/issue' && request.method === 'POST') return issueUnlockToken(request, env, context, nowMs);
  if (action === 'unlock/redeem' && request.method === 'POST') {
    await enforceUnlockRateLimits(env, request, context, 'redeem', nowMs);
    const body = await requestJson(request);
    const result = await redeemUnlockToken(env, context, body, { purpose: 'redeem', nowMs });
    return licenseJson({ unlocked: true, scope: LICENSE_SCOPE, ...result });
  }
  throw new HttpError(404, 'Not found');
}

async function readLicense(env, id) {
  const row = await env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'License not found');
  return row;
}

async function adminLicenseResponse(env, id, status = 200) {
  const row = await readLicense(env, id);
  return licenseJson({ license: licenseView(row, await licenseDevices(env, id)) }, status);
}

async function createLicense(env, context, { shopId, customerName, expiresAt, maxDevices, notes, requestId }, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const id = `lic-${crypto.randomUUID()}`;
  const insert = requestId
    ? env.DB.prepare(`
        INSERT INTO licenses (id, shop_id, customer_name, status, expires_at, max_devices, notes, request_id, created_by, created_at, updated_at)
        SELECT ?, shop_id, ?, 'active', ?, ?, ?, id, ?, ?, ? FROM license_requests WHERE id = ? AND status = 'pending'
      `).bind(id, customerName, expiresAt, maxDevices, notes || null, context.userId, nowIso, nowIso, requestId)
    : env.DB.prepare(`
        INSERT INTO licenses (id, shop_id, customer_name, status, expires_at, max_devices, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).bind(id, shopId, customerName, expiresAt, maxDevices, notes || null, context.userId, nowIso, nowIso);
  const statements = [insert];
  if (requestId) {
    statements.push(env.DB.prepare(`
      UPDATE license_requests SET status = 'approved', license_id = ?, decided_by = ?, decided_at = ?, updated_at = ?, decision_note = ?
      WHERE id = ? AND status = 'pending'
    `).bind(id, context.email || context.userId, nowIso, nowIso, notes || null, requestId));
  }
  try {
    const results = await env.DB.batch(statements);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw new HttpError(409, 'This request has already been decided');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (/UNIQUE/i.test(String(error?.message || error))) {
      throw new HttpError(409, 'This shop already has a license. Edit, suspend, or revoke it instead.');
    }
    throw error;
  }
  const row = await readLicense(env, id);
  await recordLicenseAudit(env, 'license.created', {
    licenseId: id, requestId, shopId: row.shop_id, actor: context,
    detail: { expiresAt, maxDevices, customerName },
  }, nowMs);
  if (requestId) {
    await recordLicenseAudit(env, 'request.approved', { licenseId: id, requestId, shopId: row.shop_id, actor: context, detail: { expiresAt } }, nowMs);
  }
  return id;
}

async function changeLicenseStatus(env, context, id, action, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const transitions = {
    suspend: { sql: "status = 'suspended', suspended_at = ?, token_version = token_version + 1", from: ['active'], event: 'license.suspended' },
    reactivate: { sql: "status = 'active', suspended_at = NULL, token_version = token_version + 1", from: ['suspended'], event: 'license.reactivated' },
    revoke: { sql: "status = 'revoked', revoked_at = ?, token_version = token_version + 1", from: ['active', 'suspended'], event: 'license.revoked' },
    reissue: { sql: 'token_version = token_version + 1', from: ['active', 'suspended'], event: 'license.reissued' },
  };
  const rule = transitions[action];
  const before = await readLicense(env, id);
  if (!rule.from.includes(before.status)) throw new HttpError(409, `A ${before.status} license cannot be changed with ${action}`);
  const binds = rule.sql.includes('?') ? [nowIso] : [];
  const placeholders = rule.from.map(() => '?').join(', ');
  const result = await env.DB.prepare(`UPDATE licenses SET ${rule.sql}, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
    .bind(...binds, nowIso, id, ...rule.from).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new HttpError(409, 'The license changed; refresh and try again');
  await recordLicenseAudit(env, rule.event, {
    licenseId: id, shopId: before.shop_id, actor: context,
    detail: { fromStatus: before.status, tokenVersion: Number(before.token_version) + 1 },
  }, nowMs);
}

async function updateLicense(env, context, id, body, nowMs) {
  const before = await readLicense(env, id);
  if (before.status === 'revoked') throw new HttpError(409, 'A revoked license cannot be edited');
  const expiresAt = body.expiresAt !== undefined ? parseLicenseExpiry(body.expiresAt, nowMs) : before.expires_at;
  const maxDevices = parseDeviceCount(body.maxDevices, Number(before.max_devices));
  const customerName = body.customerName !== undefined ? cleanText(body.customerName, 160) : before.customer_name;
  if (!customerName) throw new HttpError(400, 'Customer name is required');
  const notes = body.notes !== undefined ? cleanText(body.notes, 2000) : before.notes;
  await env.DB.prepare(`
    UPDATE licenses SET expires_at = ?, max_devices = ?, customer_name = ?, notes = ?, updated_at = ? WHERE id = ?
  `).bind(expiresAt, maxDevices, customerName, notes || null, new Date(nowMs).toISOString(), id).run();
  await recordLicenseAudit(env, 'license.updated', {
    licenseId: id, shopId: before.shop_id, actor: context,
    detail: {
      expiresAt: expiresAt !== before.expires_at ? { from: before.expires_at, to: expiresAt } : undefined,
      expiryShortened: Date.parse(expiresAt) < Date.parse(before.expires_at) || undefined,
      maxDevices: maxDevices !== Number(before.max_devices) ? { from: Number(before.max_devices), to: maxDevices } : undefined,
      customerName: customerName !== before.customer_name ? customerName : undefined,
    },
  }, nowMs);
}

async function serveProofFile(env, requestRow) {
  if (!requestRow.proof_file_key || !env.FILES) throw new HttpError(404, 'No proof file was uploaded');
  const object = await env.FILES.get(requestRow.proof_file_key);
  if (!object) throw new HttpError(404, 'Proof file not found');
  const headers = new Headers(NO_REFERRER);
  object.writeHttpMetadata?.(headers);
  const fileName = String(requestRow.proof_file_name || 'license-proof').replace(/[^\w.-]+/g, '_');
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}

/** Platform owner console (/api/admin/licenses/*). Only ACCESS_ADMIN_EMAILS identities (super_admin). */
export async function handleLicenseAdmin(request, env, context, segments, options = {}) {
  if (context.role !== 'super_admin') throw new HttpError(403, 'Only the ShopCrank platform owner can manage licenses');
  const nowMs = nowFn(options)();
  const [, , first, second, third, fourth] = segments.map(item => decodeURIComponent(item));
  const method = request.method;
  if (!first && method === 'GET') {
    const [{ results: licenses = [] }, { results: requests = [] }, { results: devices = [] }] = await Promise.all([
      env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500').all(),
      env.DB.prepare('SELECT * FROM license_requests ORDER BY CASE status WHEN \'pending\' THEN 0 ELSE 1 END, created_at DESC LIMIT 200').all(),
      env.DB.prepare('SELECT * FROM license_devices ORDER BY bound_at').all(),
    ]);
    return licenseJson({
      licenses: licenses.map(row => licenseView(row, devices.filter(device => device.license_id === row.id).map(device => ({
        deviceId: device.device_id, label: device.label || '', status: device.status, boundAt: device.bound_at,
        revokedAt: device.revoked_at || null, useCount: Number(device.use_count || 0), lastUsedAt: device.last_used_at || null,
      })))),
      requests: requests.map(row => requestView(row, { admin: true })),
    });
  }
  if (!first && method === 'POST') {
    const body = await requestJson(request);
    const shopId = cleanText(body.shopId, 64).toLowerCase();
    const customerName = cleanText(body.customerName, 160);
    if (!shopId || !customerName) throw new HttpError(400, 'Shop ID and customer name are required');
    const id = await createLicense(env, context, {
      shopId, customerName, expiresAt: parseLicenseExpiry(body.expiresAt, nowMs),
      maxDevices: parseDeviceCount(body.maxDevices, 1), notes: cleanText(body.notes, 2000),
    }, nowMs);
    return adminLicenseResponse(env, id, 201);
  }
  if (first === 'audit' && method === 'GET') {
    const params = new URL(request.url).searchParams;
    const limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 200));
    const licenseId = cleanText(params.get('licenseId'), 80);
    const statement = licenseId
      ? env.DB.prepare('SELECT * FROM license_audit_log WHERE license_id = ? ORDER BY created_at DESC LIMIT ?').bind(licenseId, limit)
      : env.DB.prepare('SELECT * FROM license_audit_log ORDER BY created_at DESC LIMIT ?').bind(limit);
    const { results = [] } = await statement.all();
    return licenseJson({
      events: results.map(row => ({
        id: row.id, event: row.event, licenseId: row.license_id, requestId: row.request_id, shopId: row.shop_id,
        deviceId: row.device_id, jti: row.jti, actorEmail: row.actor_email, detail: JSON.parse(row.detail_json || '{}'),
        createdAt: row.created_at,
      })),
    });
  }
  if (first === 'requests' && second) {
    const row = await env.DB.prepare('SELECT * FROM license_requests WHERE id = ?').bind(second).first();
    if (!row) throw new HttpError(404, 'License request not found');
    if (third === 'proof' && method === 'GET') return serveProofFile(env, row);
    if (third === 'approve' && method === 'POST') {
      const body = await requestJson(request);
      const expiresAt = parseLicenseExpiry(body.expiresAt, nowMs);
      const existing = await env.DB.prepare("SELECT id FROM licenses WHERE shop_id = ? AND status != 'revoked'").bind(row.shop_id).first();
      if (existing) throw new HttpError(409, 'This shop already has a license. Edit, suspend, or revoke it instead.');
      const id = await createLicense(env, context, {
        customerName: cleanText(body.customerName, 160) || row.business_name,
        expiresAt,
        maxDevices: parseDeviceCount(body.maxDevices, Number(row.requested_devices)),
        notes: cleanText(body.notes, 2000),
        requestId: row.id,
      }, nowMs);
      return adminLicenseResponse(env, id, 201);
    }
    if (third === 'deny' && method === 'POST') {
      const body = await requestJson(request);
      const reason = cleanText(body.reason, 1000);
      if (!reason) throw new HttpError(400, 'Give the customer a reason for the denial');
      const nowIso = new Date(nowMs).toISOString();
      const result = await env.DB.prepare(`
        UPDATE license_requests SET status = 'denied', decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(reason, context.email || context.userId, nowIso, nowIso, row.id).run();
      if (Number(result?.meta?.changes || 0) !== 1) throw new HttpError(409, 'This request has already been decided');
      await recordLicenseAudit(env, 'request.denied', { requestId: row.id, shopId: row.shop_id, actor: context, detail: { reason } }, nowMs);
      return licenseJson({ request: requestView({ ...row, status: 'denied', decision_note: reason, decided_at: nowIso }, { admin: true }) });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (first) {
    if (!second && method === 'GET') return adminLicenseResponse(env, first);
    if (!second && (method === 'PUT' || method === 'PATCH')) {
      await updateLicense(env, context, first, await requestJson(request), nowMs);
      return adminLicenseResponse(env, first);
    }
    if (['suspend', 'reactivate', 'revoke', 'reissue'].includes(second) && !third && method === 'POST') {
      await changeLicenseStatus(env, context, first, second, nowMs);
      return adminLicenseResponse(env, first);
    }
    if (second === 'devices' && third && fourth === 'revoke' && method === 'POST') {
      const license = await readLicense(env, first);
      const nowIso = new Date(nowMs).toISOString();
      const result = await env.DB.prepare(`
        UPDATE license_devices SET status = 'revoked', revoked_at = ? WHERE license_id = ? AND device_id = ? AND status = 'active'
      `).bind(nowIso, first, third).run();
      if (Number(result?.meta?.changes || 0) !== 1) throw new HttpError(404, 'Active device not found on this license');
      await recordLicenseAudit(env, 'device.revoked', { licenseId: first, shopId: license.shop_id, deviceId: third, actor: context }, nowMs);
      return adminLicenseResponse(env, first);
    }
  }
  throw new HttpError(404, 'Not found');
}
