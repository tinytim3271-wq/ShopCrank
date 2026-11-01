// Ambassador records and membership attribution ("sold by"). Every membership
// creation path calls applyAttribution so credit is set and audited the same way.

import { HttpError } from '../http.mjs';

export const AMBASSADOR_STATUSES = Object.freeze(['applied', 'approved', 'suspended']);
export const SALE_SOURCES = Object.freeze(['shopcrank_online', 'ambassador_site', 'ambassador_referral', 'admin_manual', 'ai_agent']);
export const AMBASSADOR_SALE_SOURCES = Object.freeze(['ambassador_site', 'ambassador_referral']);
export const SALE_SOURCE_LABELS = Object.freeze({
  shopcrank_online: 'ShopCrank online',
  ambassador_site: 'Ambassador site',
  ambassador_referral: 'Ambassador referral',
  admin_manual: 'Admin manual',
  ai_agent: 'AI agent',
});

// No 0/O/1/I/L so codes survive being read aloud or handwritten.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_PATTERN = /^[A-Z0-9]{4,16}$/;

const str = (value, max = 200) => String(value ?? '').trim().slice(0, max);

export function normalizeReferralCode(value) {
  const code = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return REFERRAL_CODE_PATTERN.test(code) ? code : '';
}

export function isSaleSource(value) {
  return SALE_SOURCES.includes(value);
}

export function ambassadorNumber(seq) {
  return `AMB-${String(seq).padStart(4, '0')}`;
}

export function randomReferralCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function soldByLabel(ambassador) {
  return ambassador ? `${ambassador.ambassador_number} · ${ambassador.name}` : '';
}

export function publicAmbassador(row) {
  if (!row) return null;
  let application = null;
  try { application = row.application_json ? JSON.parse(row.application_json) : null; } catch { application = null; }
  return {
    id: row.id,
    ambassadorNumber: row.ambassador_number,
    referralCode: row.referral_code,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    status: row.status,
    territory: row.territory || '',
    mailingAddress: row.mailing_address || '',
    payoutMethod: row.payout_method || 'check',
    payoutDetails: row.payout_details || '',
    application,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates admin/applicant input. `partial` allows updates that omit fields. */
export function normalizeAmbassadorInput(input = {}, { partial = false } = {}) {
  const out = {};
  const has = key => Object.prototype.hasOwnProperty.call(input, key);
  if (!partial || has('name')) {
    out.name = str(input.name, 120);
    if (!out.name) throw new HttpError(400, 'Ambassador name is required');
  }
  if (!partial || has('email')) {
    out.email = str(input.email, 254).toLowerCase();
    if (!EMAIL_PATTERN.test(out.email)) throw new HttpError(400, 'A valid ambassador email is required');
  }
  if (has('phone')) out.phone = str(input.phone, 40);
  if (has('territory')) out.territory = str(input.territory, 200);
  if (has('mailingAddress')) out.mailing_address = str(input.mailingAddress, 600);
  if (has('payoutMethod')) out.payout_method = str(input.payoutMethod, 40) || 'check';
  if (has('payoutDetails')) out.payout_details = str(input.payoutDetails, 600);
  if (has('notes')) out.notes = str(input.notes, 2000);
  if (has('status')) {
    if (!AMBASSADOR_STATUSES.includes(input.status)) throw new HttpError(400, 'Status must be applied, approved, or suspended');
    out.status = input.status;
  }
  if (has('referralCode') && input.referralCode !== '' && input.referralCode !== null) {
    out.referral_code = normalizeReferralCode(input.referralCode);
    if (!out.referral_code) throw new HttpError(400, 'Referral codes are 4-16 letters or numbers');
  }
  return out;
}

function uniqueViolation(error) {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error instanceof Error ? error.message : String(error));
}

/** Inserts with the next AMB-#### number and a random code, retrying on collisions. */
export async function createAmbassador(env, input, { actor = 'system', status = 'approved', application = null } = {}) {
  const fields = normalizeAmbassadorInput(input);
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ambassadors').first();
    const seq = Number(row?.next || 1);
    const id = crypto.randomUUID();
    const code = fields.referral_code || randomReferralCode();
    try {
      await env.DB.prepare(`
        INSERT INTO ambassadors (
          id, seq, ambassador_number, referral_code, name, email, phone, status, territory,
          mailing_address, payout_method, payout_details, application_json, notes, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, seq, ambassadorNumber(seq), code, fields.name, fields.email, fields.phone || null,
        fields.status || status, fields.territory || null, fields.mailing_address || null,
        fields.payout_method || 'check', fields.payout_details || null,
        application ? JSON.stringify(application) : null, fields.notes || null, now, now, actor,
      ).run();
      return getAmbassador(env, id);
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      if (fields.referral_code) {
        const taken = await env.DB.prepare('SELECT id FROM ambassadors WHERE referral_code = ?').bind(fields.referral_code).first();
        if (taken) throw new HttpError(409, 'That referral code is already in use');
      }
    }
  }
  throw new HttpError(503, 'Could not allocate an ambassador number; try again');
}

export async function getAmbassador(env, id) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM ambassadors WHERE id = ?').bind(String(id)).first();
}

export async function getAmbassadorByCode(env, code) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  return env.DB.prepare('SELECT * FROM ambassadors WHERE referral_code = ? COLLATE NOCASE').bind(normalized).first();
}

export async function updateAmbassador(env, id, input) {
  const existing = await getAmbassador(env, id);
  if (!existing) throw new HttpError(404, 'Ambassador not found');
  const fields = normalizeAmbassadorInput(input, { partial: true });
  const keys = Object.keys(fields);
  if (!keys.length) return existing;
  try {
    await env.DB.prepare(`UPDATE ambassadors SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map(key => fields[key]), new Date().toISOString(), existing.id).run();
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, 'That referral code is already in use');
    throw error;
  }
  return getAmbassador(env, existing.id);
}

/**
 * Turn whatever a creation path received (an ambassador id, a referral code,
 * a requested source) into a credited ambassador and sale_source.
 * Public paths (`trusted = false`) only credit approved ambassadors.
 */
export async function resolveAttribution(env, {
  ambassadorId = '',
  referralCode = '',
  saleSource = '',
  defaultSource = 'shopcrank_online',
  trusted = false,
} = {}) {
  let ambassador = null;
  if (ambassadorId) ambassador = await getAmbassador(env, ambassadorId);
  if (!ambassador && referralCode) ambassador = await getAmbassadorByCode(env, referralCode);
  if (ambassador && ambassador.status === 'suspended') ambassador = null;
  if (ambassador && !trusted && ambassador.status !== 'approved') ambassador = null;
  if (trusted && ambassadorId && !ambassador) throw new HttpError(400, 'Choose an approved or applied ambassador');
  let source = isSaleSource(saleSource) ? saleSource : '';
  if (!trusted) {
    // Self-serve callers may only pick between the two ambassador sources.
    source = ambassador
      ? (AMBASSADOR_SALE_SOURCES.includes(source) ? source : 'ambassador_site')
      : defaultSource;
  } else if (!source) {
    source = defaultSource;
  }
  return { ambassador, saleSource: source };
}

/**
 * Write sold_by_ambassador_id / sold_by / sale_source on a shop's subscription
 * and append an audit row. With `onlyIfUncredited`, an existing ambassador
 * credit is kept (first ambassador touch wins for self-serve paths).
 */
export async function applyAttribution(env, shopId, {
  ambassador = null,
  saleSource,
  soldBy = '',
  referralCode = '',
  changedBy,
  reason = '',
  onlyIfUncredited = false,
} = {}) {
  if (!isSaleSource(saleSource)) throw new HttpError(400, `sale_source must be one of: ${SALE_SOURCES.join(', ')}`);
  const current = await env.DB.prepare(
    'SELECT shop_id, sold_by_ambassador_id, sold_by, sale_source FROM subscriptions WHERE shop_id = ?',
  ).bind(shopId).first();
  if (!current) throw new HttpError(404, 'Membership not found');
  if (onlyIfUncredited && (current.sold_by_ambassador_id || (current.sale_source && !ambassador))) {
    return { changed: false, reason: 'already_attributed' };
  }
  const nextAmbassadorId = ambassador?.id || null;
  const nextSoldBy = str(soldBy, 200) || soldByLabel(ambassador) || SALE_SOURCE_LABELS[saleSource];
  if ((current.sold_by_ambassador_id || null) === nextAmbassadorId
    && current.sale_source === saleSource
    && (current.sold_by || '') === nextSoldBy) {
    return { changed: false, reason: 'unchanged' };
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE subscriptions SET sold_by_ambassador_id = ?, sold_by = ?, sale_source = ?,
        referral_code = COALESCE(?, referral_code), attributed_at = ?
      WHERE shop_id = ?
    `).bind(nextAmbassadorId, nextSoldBy, saleSource, normalizeReferralCode(referralCode) || ambassador?.referral_code || null, now, shopId),
    env.DB.prepare(`
      INSERT INTO ambassador_attribution_log (
        id, shop_id, previous_ambassador_id, new_ambassador_id, previous_source, new_source,
        previous_sold_by, new_sold_by, changed_by, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), shopId, current.sold_by_ambassador_id || null, nextAmbassadorId,
      current.sale_source || null, saleSource, current.sold_by || null, nextSoldBy,
      String(changedBy || 'system'), str(reason, 500) || null, now,
    ),
  ]);
  return { changed: true, ambassadorId: nextAmbassadorId, saleSource, soldBy: nextSoldBy };
}

/** Resolve + apply in one step; used by every membership creation path. */
export async function attributeMembership(env, shopId, request = {}) {
  const resolved = await resolveAttribution(env, request);
  return applyAttribution(env, shopId, {
    ambassador: resolved.ambassador,
    saleSource: resolved.saleSource,
    soldBy: request.soldBy,
    referralCode: request.referralCode,
    changedBy: request.changedBy,
    reason: request.reason,
    onlyIfUncredited: request.onlyIfUncredited,
  });
}
