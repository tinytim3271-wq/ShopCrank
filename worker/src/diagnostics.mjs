import { base64UrlDecode, base64UrlEncode, ecdsaP256SignBase64Url, importEcdsaPrivateKey, importEcdsaPublicKeyFromPrivate } from './security.mjs';

const encoder = new TextEncoder();

/**
 * Diagnostic/programming procedures the platform can authorize. `autoAuth`
 * procedures touch immobilizer/security-gateway or ECU firmware and, in LIVE
 * mode against real hardware, require licensed OEM AutoAuth credentials
 * configured for the shop. Nissan Maxima immobilizer jobs use the vehicle PIN
 * instead of Stellantis AutoAuth. SIMULATE mode drives only the bench simulator
 * and is always available for development and training.
 */
export const DIAGNOSTIC_PROCEDURES = {
  clear_dtcs: { klass: 'dtc', mutating: true, autoAuth: false, ttlMs: 5 * 60 * 1000 },
  add_key: { klass: 'immobilizer', mutating: true, autoAuth: true, ttlMs: 10 * 60 * 1000 },
  all_keys_lost: { klass: 'immobilizer', mutating: true, autoAuth: true, ttlMs: 10 * 60 * 1000 },
  program_remote: { klass: 'immobilizer', mutating: true, autoAuth: true, ttlMs: 10 * 60 * 1000 },
  erase_keys: { klass: 'immobilizer', mutating: true, autoAuth: true, ttlMs: 10 * 60 * 1000 },
  module_flash: { klass: 'flash', mutating: true, autoAuth: true, ttlMs: 30 * 60 * 1000 },
  module_coding: { klass: 'coding', mutating: true, autoAuth: true, ttlMs: 15 * 60 * 1000 },
  bidirectional_control: { klass: 'bidirectional', mutating: true, autoAuth: true, ttlMs: 10 * 60 * 1000 },
};

export const PROGRAMMING_MODES = new Set(['simulate', 'live']);

export function procedureSpec(procedure) {
  return DIAGNOSTIC_PROCEDURES[String(procedure || '').trim()] || null;
}

const NISSAN_MAXIMA_WMI = new Set(['1N4', 'JN1']);
const NISSAN_MAXIMA_VDS = new Set(['AA', 'BA']);

/** Nissan Maxima NATS / Intelligent Key registration uses the vehicle PIN, not Stellantis AutoAuth. */
export function isNissanMaximaVin(vin) {
  const value = String(vin || '').trim().toUpperCase();
  if (value.length < 5) return false;
  return NISSAN_MAXIMA_WMI.has(value.slice(0, 3)) && NISSAN_MAXIMA_VDS.has(value.slice(3, 5));
}

export function requiresAutoAuthLogin(spec, vin) {
  if (!spec?.autoAuth) return false;
  if (spec.klass === 'immobilizer' && isNissanMaximaVin(vin)) return false;
  return true;
}

/**
 * Mint an ECDSA P-256 signed capability token (format `v2.<payload>.<sig>`).
 * The token is scoped to a single procedure, VIN, shop, and mode, is single-use
 * (jti), and expires. Clients hold only the public key and cannot forge these.
 */
export async function mintCapabilityToken(env, { procedure, vin, shopId, mode, actor, expiresAt }) {
  const spec = procedureSpec(procedure);
  if (!spec) throw new Error(`Unknown diagnostic procedure: ${procedure}`);
  const privateKey = await importEcdsaPrivateKey(env.DIAGNOSTICS_SIGNING_PRIVATE_KEY);
  const now = Date.now();
  const expiryLimit = expiresAt === undefined ? Infinity : Date.parse(expiresAt);
  if (!Number.isFinite(expiryLimit) && expiryLimit !== Infinity) throw new Error('Invalid authorization expiry');
  if (expiryLimit <= now) throw new Error('Authorization has expired');
  const payload = {
    v: 2,
    procedure,
    scope: spec.klass,
    vin,
    shopId,
    mode,
    actor: actor || null,
    iat: now,
    exp: Math.min(now + spec.ttlMs, expiryLimit),
    jti: crypto.randomUUID().replaceAll('-', ''),
  };
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `v2.${payloadB64}`;
  const signature = await ecdsaP256SignBase64Url(privateKey, signingInput);
  return { token: `${signingInput}.${signature}`, payload };
}

/**
 * Verify a capability token this Worker minted. Returns the payload only when the
 * signature, shop, VIN, mode, and scope all match and it has not expired; null
 * otherwise. Not single-use here: one job can request SecurityAccess repeatedly.
 */
/**
 * UDS SecurityAccess level for each unlock scope, as J2534.Host sends them
 * (requestSeed 0x03 immobilizer, 0x05 programming). The Worker derives the scope
 * from the level so a caller cannot ask for an immobilizer key under a flash job.
 */
export const SECURITY_ACCESS_LEVELS = Object.freeze({ immobilizer: 0x03, flash: 0x05 });

/** Job scopes whose capability token may request each SecurityAccess unlock. Module coding writes need the programming unlock. */
export const SECURITY_ACCESS_TOKEN_SCOPES = Object.freeze({ immobilizer: ['immobilizer'], flash: ['flash', 'coding'] });

export function securityAccessScopeForLevel(level) {
  return Object.entries(SECURITY_ACCESS_LEVELS).find(([, value]) => value === Number(level))?.[0] || null;
}

export async function verifyCapabilityToken(env, token, { shopId, vin, mode, scope, scopes = [scope], nowMs = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v2' || !env.DIAGNOSTICS_SIGNING_PRIVATE_KEY) return null;
  let payload;
  try {
    const publicKey = await importEcdsaPublicKeyFromPrivate(env.DIAGNOSTICS_SIGNING_PRIVATE_KEY);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, base64UrlDecode(parts[2]), encoder.encode(`v2.${parts[1]}`),
    );
    if (!valid) return null;
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }
  if (payload?.v !== 2 || payload.shopId !== shopId || payload.vin !== vin) return null;
  if (payload.mode !== mode || !scopes.includes(payload.scope) || procedureSpec(payload.procedure)?.klass !== payload.scope) return null;
  if (!(Number(payload.exp) > nowMs)) return null;
  return payload;
}

/**
 * Live key programming is authorized by a signed repair order in the shop's own
 * records rather than an AutoAuth login: the order must carry this VIN and have
 * an approved, signed estimateApproval recorded through the Worker approval path.
 *
 * Do not trust the separate `estimates` entity register — those status/signedAt
 * fields are client-writable without server validation and can forge this gate.
 */
export async function signedRepairOrderForKeys(db, shopId, orderId, vin) {
  const id = String(orderId || '').trim();
  const wanted = String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!id || !shopId || wanted.length !== 17) return null;
  const order = await db.prepare(
    "SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'orders' AND entity_id = ?",
  ).bind(shopId, id).first();
  if (!order) return null;
  let orderData = {};
  try { orderData = JSON.parse(order.data_json || '{}'); } catch { return null; }
  if (String(orderData.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== wanted) return null;
  const approval = orderData.estimateApproval;
  if (
    approval
    && approval.status === 'approved'
    && String(approval.type || 'signature').trim().toLowerCase() === 'signature'
    && orderData.linesLockedAt
    && Number.isFinite(Date.parse(approval.signedAt))
    && String(approval.authorizationName || '').trim()
  ) {
    return {
      estimateId: String(orderData.id || id),
      authorizationName: approval.authorizationName,
      signedAt: approval.signedAt,
      signatureKey: approval.signatureKey || null,
      type: approval.type || null,
    };
  }
  return null;
}
