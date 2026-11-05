// Paid membership coverage for ambassador commissions. A month earns a
// commission only if some coverage interval overlaps it, and coverage is
// written from exactly two kinds of evidence:
//   - a Stripe invoice.paid whose membership line charged money (stripe_invoice)
//   - an explicit admin grant of an active, admin-paid membership (admin)
// Nothing else (subscription status, Checkout, billing periods) creates it.
//
// Ending coverage cuts the interval at that moment and records where it would
// have ended (paid_through) and why (cut_reason), for audit only. Nothing ever
// re-opens a cut interval: lifting a suspension restores no coverage, and the
// shop earns again only from its next paid invoice or a new admin activation.
// A suspended shop gets no new coverage at all. This can under-credit the rest
// of a month after a restore, but it never pays for unpaid or suspended time.

import { FOUNDING_PLANS, PUBLIC_PLANS } from '../plans.mjs';

const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = value => (value ? iso(value) : null);

export async function recordPaidCoverage(env, shopId, startsAt, endsAt = null, { source = 'stripe_invoice' } = {}) {
  // A cut interval stays cut: a repeated or late write cannot re-open it.
  return env.DB.prepare(`
    INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, starts_at) DO UPDATE SET
      ends_at = CASE WHEN ambassador_paid_coverage.cut_reason IS NULL
        THEN COALESCE(excluded.ends_at, ambassador_paid_coverage.ends_at) ELSE ambassador_paid_coverage.ends_at END,
      source = CASE WHEN ambassador_paid_coverage.cut_reason IS NULL THEN excluded.source ELSE ambassador_paid_coverage.source END
  `).bind(shopId, iso(startsAt), isoOrNull(endsAt), source, new Date().toISOString()).run();
}

/**
 * Record a rejected paid interval as excluded (stored already cut), so a later
 * replay of the same invoice, even under a new webhook event ID, cannot turn it
 * into coverage or a commission. An interval already stored for that start is
 * left exactly as it is: an earlier, genuinely paid period is never erased.
 */
export async function excludePaidCoverage(env, shopId, startsAt, endsAt = null, { reason = 'suspension', source = 'stripe_invoice' } = {}) {
  return env.DB.prepare(`
    INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, paid_through, cut_reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, starts_at) DO NOTHING
  `).bind(shopId, iso(startsAt), iso(startsAt), isoOrNull(endsAt), reason, source, new Date().toISOString()).run();
}

/**
 * The writes that suspend or restore a shop, for one atomic D1 batch: the
 * caller's account flag update goes first, then the suspension history and
 * (when suspending) the coverage cutoff. Run together, overlapping suspend and
 * restore requests can never leave the flag and the open period disagreeing.
 */
export function suspensionStatements(env, shopId, suspended, at = new Date()) {
  const when = iso(at);
  if (!suspended) {
    return [env.DB.prepare(`
      UPDATE ambassador_suspension_periods SET ended_at = ? WHERE shop_id = ? AND ended_at IS NULL
    `).bind(when, shopId)];
  }
  return [
    env.DB.prepare(`
      INSERT INTO ambassador_suspension_periods (shop_id, started_at, ended_at)
      SELECT ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM accounts WHERE shop_id = ? AND suspended = 1)
        AND NOT EXISTS (SELECT 1 FROM ambassador_suspension_periods WHERE shop_id = ? AND ended_at IS NULL)
    `).bind(shopId, when, shopId, shopId),
    endPaidCoverageStatement(env, shopId, when, { reason: 'suspension' }),
  ];
}

/** True when `at` falls inside one of the shop's suspension periods. */
export async function suspendedAt(env, shopId, at) {
  const when = iso(at);
  const row = await env.DB.prepare(`
    SELECT 1 FROM ambassador_suspension_periods
    WHERE shop_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
    LIMIT 1
  `).bind(shopId, when, when).first();
  return Boolean(row);
}

/** When Stripe says the invoice was paid (falls back to its creation time). */
export function invoicePaidAt(invoice) {
  const seconds = Number(invoice?.status_transitions?.paid_at || invoice?.created || 0);
  return seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** True when the interval starting at `startsAt` was cut or excluded; it never earns again. */
export async function coverageExcluded(env, shopId, startsAt) {
  const row = await env.DB.prepare(`
    SELECT 1 FROM ambassador_paid_coverage WHERE shop_id = ? AND starts_at = ? AND cut_reason IS NOT NULL
  `).bind(shopId, iso(startsAt)).first();
  return Boolean(row);
}

/**
 * Cut every interval still running at `at` (and retire later ones) so the
 * time after `at` is unpaid. `sources` limits which evidence is cut.
 */
export function endPaidCoverageStatement(env, shopId, at = new Date(), { reason = 'membership_change', sources = null } = {}) {
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
  `).bind(reason, when, when, shopId, when, reason, ...(sources || []));
}

export async function endPaidCoverage(env, shopId, at = new Date(), options = {}) {
  return endPaidCoverageStatement(env, shopId, at, options).run();
}

/**
 * An admin activated a paid membership by hand: open-ended admin coverage from
 * `at`. Idempotent, so a retry after a failed write repairs missing coverage.
 * A suspended account gets none.
 */
export async function grantAdminCoverage(env, shopId, at = new Date()) {
  const when = iso(at);
  const account = await env.DB.prepare('SELECT suspended FROM accounts WHERE shop_id = ?').bind(shopId).first();
  // A suspended account gets none; activate it again after restoring it.
  if (Number(account?.suspended) === 1) return { recorded: false, reason: 'account_suspended' };
  const running = await env.DB.prepare(`
    SELECT 1 FROM ambassador_paid_coverage
    WHERE shop_id = ? AND source = 'admin' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
    LIMIT 1
  `).bind(shopId, when, when).first();
  if (running) return { recorded: false };
  await recordPaidCoverage(env, shopId, when, null, { source: 'admin' });
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
