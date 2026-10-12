import { base64UrlEncode, ecdsaP256SignBase64Url, importEcdsaPrivateKey } from './security.mjs';

const encoder = new TextEncoder();

/**
 * Diagnostic/programming procedures the platform can authorize. `autoAuth`
 * procedures touch immobilizer/security-gateway or ECU firmware and, in LIVE
 * mode against real hardware, require licensed Stellantis AutoAuth credentials
 * configured for the shop. SIMULATE mode drives only the bench simulator and
 * is always available for development and training.
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

/**
 * Mint an ECDSA P-256 signed capability token (format `v2.<payload>.<sig>`).
 * The token is scoped to a single procedure, VIN, shop, and mode, is single-use
 * (jti), and expires. Clients hold only the public key and cannot forge these.
 */
export async function mintCapabilityToken(env, { procedure, vin, shopId, mode, actor }) {
  const spec = procedureSpec(procedure);
  if (!spec) throw new Error(`Unknown diagnostic procedure: ${procedure}`);
  const privateKey = await importEcdsaPrivateKey(env.DIAGNOSTICS_SIGNING_PRIVATE_KEY);
  const now = Date.now();
  const payload = {
    v: 2,
    procedure,
    scope: spec.klass,
    vin,
    shopId,
    mode,
    actor: actor || null,
    iat: now,
    exp: now + spec.ttlMs,
    jti: crypto.randomUUID().replaceAll('-', ''),
  };
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `v2.${payloadB64}`;
  const signature = await ecdsaP256SignBase64Url(privateKey, signingInput);
  return { token: `${signingInput}.${signature}`, payload };
}

/**
 * Live key programming is authorized by a signed repair order in the shop's own
 * records rather than an AutoAuth login: the order must carry this VIN and have
 * an approved, signed estimate. Returns the signature details or null.
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
  const { results = [] } = await db.prepare(
    "SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'estimates' AND json_extract(data_json, '$.workOrderId') = ?",
  ).bind(shopId, id).all();
  for (const row of results) {
    let estimate = {};
    try { estimate = JSON.parse(row.data_json || '{}'); } catch { continue; }
    if (estimate.workOrderId !== id) continue;
    if (estimate.status === 'approved' && estimate.signedAt && String(estimate.authorizationName || '').trim()) {
      return { estimateId: estimate.id || '', authorizationName: estimate.authorizationName, signedAt: estimate.signedAt };
    }
  }
  return null;
}
