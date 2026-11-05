// Paid membership coverage for ambassador commissions. A month earns a
// commission only if some coverage interval overlaps it, and coverage is
// written from exactly two kinds of evidence:
//   - a Stripe invoice.paid whose membership line charged money (stripe_invoice)
//   - an explicit admin grant of an active, admin-paid membership (admin)
// Nothing else (subscription status, Checkout, billing periods) creates it.
//
// Ending coverage never deletes evidence: the interval is cut at the moment it
// stops and remembers where it would have ended (paid_through) and why
// (cut_reason). Lifting a suspension re-opens exactly what the suspension cut,
// up to the original paid-through date, so a suspended stretch is never paid.

import { FOUNDING_PLANS, PUBLIC_PLANS } from '../plans.mjs';

const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = value => (value ? iso(value) : null);

export async function recordPaidCoverage(env, shopId, startsAt, endsAt = null, { source = 'stripe_invoice', cutReason = null } = {}) {
  const start = iso(startsAt);
  const end = isoOrNull(endsAt);
  // A cut row is stored already ended (zero length) and keeps its paid-through date.
  const [storedEnd, paidThrough] = cutReason ? [start, end] : [end, null];
  return env.DB.prepare(`
    INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, paid_through, cut_reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, starts_at) DO UPDATE SET
      ends_at = CASE WHEN ambassador_paid_coverage.cut_reason IS NULL AND excluded.cut_reason IS NULL
        THEN COALESCE(excluded.ends_at, ambassador_paid_coverage.ends_at) ELSE ambassador_paid_coverage.ends_at END,
      paid_through = COALESCE(ambassador_paid_coverage.paid_through, excluded.paid_through),
      source = excluded.source
  `).bind(shopId, start, storedEnd, paidThrough, cutReason, source, new Date().toISOString()).run();
}

/**
 * Cut every interval still running at `at` (and retire later ones) so the
 * time after `at` is unpaid. `sources` limits which evidence is cut.
 */
export async function endPaidCoverage(env, shopId, at = new Date(), { reason = 'membership_change', sources = null } = {}) {
  const when = iso(at);
  const sourceFilter = sources?.length ? ` AND source IN (${sources.map(() => '?').join(', ')})` : '';
  return env.DB.prepare(`
    UPDATE ambassador_paid_coverage
    SET paid_through = CASE WHEN cut_reason = 'suspension' THEN paid_through ELSE ends_at END,
        cut_reason = ?,
        ends_at = CASE WHEN cut_reason = 'suspension' THEN ends_at
          WHEN starts_at > ? THEN starts_at ELSE ? END
    WHERE shop_id = ? AND (
      ends_at IS NULL OR (ends_at > ? AND ends_at > starts_at)
      OR (cut_reason = 'suspension' AND ? != 'suspension')
    )${sourceFilter}
  `).bind(reason, when, when, shopId, when, reason, ...(sources || [])).run();
}

/** Lifting a suspension re-opens what it cut, through the original paid-through date. Idempotent. */
export async function resumeSuspendedCoverage(env, shopId, at = new Date()) {
  const when = iso(at);
  const now = new Date().toISOString();
  const interrupted = await env.DB.prepare(`
    SELECT starts_at, paid_through, source
    FROM ambassador_paid_coverage
    WHERE shop_id = ? AND source IN ('stripe_invoice', 'admin')
      AND cut_reason = 'suspension' AND starts_at < ?
      AND (paid_through IS NULL OR paid_through > ?)
    ORDER BY starts_at
  `).bind(shopId, when, when).all();
  const statements = [
    // Intervals that had not started yet come back whole.
    env.DB.prepare(`
      UPDATE ambassador_paid_coverage SET ends_at = paid_through, paid_through = NULL, cut_reason = NULL
      WHERE shop_id = ? AND source IN ('stripe_invoice', 'admin') AND cut_reason = 'suspension' AND starts_at >= ?
    `).bind(shopId, when),
    // Preserve each interrupted interval's source and paid-through boundary.
    ...(interrupted.results || []).map((row, index) => env.DB.prepare(`
      INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, starts_at) DO NOTHING
    `).bind(shopId, new Date(Date.parse(when) + index).toISOString(), row.paid_through, row.source, now)),
    env.DB.prepare(`
      UPDATE ambassador_paid_coverage SET cut_reason = 'suspension_resumed'
      WHERE shop_id = ? AND cut_reason = 'suspension'
    `).bind(shopId),
  ];
  const results = await env.DB.batch(statements);
  return { resumed: results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0) };
}

/**
 * An admin activated a paid membership by hand: open-ended admin coverage from
 * `at`. Idempotent, so a retry after a failed write repairs missing coverage.
 */
export async function grantAdminCoverage(env, shopId, at = new Date()) {
  const when = iso(at);
  const account = await env.DB.prepare('SELECT suspended FROM accounts WHERE shop_id = ?').bind(shopId).first();
  const running = await env.DB.prepare(`
    SELECT 1 FROM ambassador_paid_coverage
    WHERE shop_id = ? AND source = 'admin' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
    LIMIT 1
  `).bind(shopId, when, when).first();
  if (running) return { recorded: false };
  await recordPaidCoverage(env, shopId, when, null, {
    source: 'admin',
    cutReason: Number(account?.suspended) === 1 ? 'suspension' : null,
  });
  return { recorded: true };
}

/** Every configured Stripe membership price ID (all plans, both intervals). */
export function membershipPriceIds(env) {
  const ids = new Set();
  for (const plan of [...PUBLIC_PLANS, ...FOUNDING_PLANS]) {
    for (const key of [plan.stripeMonthlyEnv, plan.stripeAnnualEnv]) {
      const id = String(env?.[key] || '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

function lineNetCents(line) {
  const discounts = Array.isArray(line?.discount_amounts)
    ? line.discount_amounts.reduce((sum, item) => sum + Number(item?.amount || 0), 0)
    : 0;
  return Number(line?.amount || 0) - discounts;
}

function linePriceId(line) {
  const price = line?.price ?? line?.pricing?.price_details?.price ?? line?.plan;
  return typeof price === 'string' ? price : String(price?.id || '');
}

/**
 * A membership fee line: a known membership price, or (when the price object is
 * expanded) an explicitly licensed recurring price. Metered usage, prorations
 * and ID-only lines for unknown prices never count.
 */
function isMembershipLine(line, priceIds) {
  if (line?.proration === true || line?.parent?.subscription_item_details?.proration === true) return false;
  const priceId = linePriceId(line);
  if (priceId && priceIds.has(priceId)) return true;
  const recurring = typeof line?.price === 'object' ? line.price?.recurring : null;
  return Boolean(recurring) && recurring.usage_type === 'licensed';
}

/** The service period of the paid membership line, or null when the invoice paid no membership fee. */
export function invoiceMembershipPeriod(invoice, env = {}) {
  const priceIds = membershipPriceIds(env);
  const lines = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [];
  const line = lines.find(item => isMembershipLine(item, priceIds) && lineNetCents(item) > 0);
  const startSeconds = Number(line?.period?.start || 0);
  if (!line || !(startSeconds > 0)) return null;
  const endSeconds = Number(line.period?.end || 0);
  return {
    start: new Date(startSeconds * 1000),
    end: endSeconds > 0 ? new Date(endSeconds * 1000) : null,
  };
}
