// Recurring monthly ambassador commissions. A shop earns its credited
// ambassador one ledger line per month while its membership is active and
// paid: from Stripe invoice.paid as it happens, and from the monthly cron for
// every membership still active (including admin-managed paid accounts).
// Cancelled, past-due, trialing, and suspended accounts accrue nothing.

import { HttpError } from '../http.mjs';

export const COMMISSION_TIERS = Object.freeze(['solo', 'shop', 'shop_pro', 'enterprise']);
export const TIER_LABELS = Object.freeze({ solo: 'Solo', shop: 'Shop', shop_pro: 'Shop Pro', enterprise: 'Enterprise' });
const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value) {
  return PERIOD_PATTERN.test(String(value || ''));
}

export function requirePeriod(value) {
  const period = String(value || '').trim();
  if (!isPeriod(period)) throw new HttpError(400, 'Period must look like YYYY-MM');
  return period;
}

export function periodOf(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftPeriod(period, months) {
  const [, year, month] = PERIOD_PATTERN.exec(period);
  return periodOf(new Date(Date.UTC(Number(year), Number(month) - 1 + months, 1)));
}

export function previousPeriod(now = new Date()) {
  return shiftPeriod(periodOf(now), -1);
}

/** [start, end) of a period as ISO strings. */
export function periodBounds(period) {
  const [, year, month] = PERIOD_PATTERN.exec(requirePeriod(period));
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  const end = new Date(Date.UTC(Number(year), Number(month), 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function periodHasEnded(period, now = new Date()) {
  return periodBounds(period).end <= now.toISOString();
}

export async function listCommissionRates(env) {
  const rows = await env.DB.prepare('SELECT plan_id, tier, monthly_cents, updated_at, updated_by FROM ambassador_commission_rates ORDER BY monthly_cents, plan_id').all();
  return (rows.results || []).map(row => ({
    planId: row.plan_id,
    tier: row.tier,
    monthlyCents: Number(row.monthly_cents),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }));
}

/** Configured rate per tier, read from the public (non-founding) plan row. */
export async function tierRates(env) {
  const rates = await listCommissionRates(env);
  const out = {};
  for (const tier of COMMISSION_TIERS) {
    out[tier] = rates.find(rate => rate.planId === tier)?.monthlyCents
      ?? rates.find(rate => rate.tier === tier)?.monthlyCents
      ?? 0;
  }
  return out;
}

export async function updateCommissionRates(env, updates, { actor }) {
  if (!Array.isArray(updates) || !updates.length) throw new HttpError(400, 'Send rates as [{ planId, monthlyCents, tier? }]');
  const now = new Date().toISOString();
  const statements = [];
  for (const update of updates) {
    const planId = String(update?.planId || '').trim();
    const cents = Math.round(Number(update?.monthlyCents));
    const tier = String(update?.tier || planId).trim();
    if (!/^[a-z0-9_]{2,40}$/.test(planId)) throw new HttpError(400, 'Each rate needs a plan ID');
    if (!Number.isFinite(cents) || cents < 0 || cents > 1_000_000) throw new HttpError(400, `Rate for ${planId} must be between $0 and $10,000`);
    if (!COMMISSION_TIERS.includes(tier)) throw new HttpError(400, `Tier for ${planId} must be one of ${COMMISSION_TIERS.join(', ')}`);
    statements.push(env.DB.prepare(`
      INSERT INTO ambassador_commission_rates (plan_id, tier, monthly_cents, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET tier = excluded.tier, monthly_cents = excluded.monthly_cents,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).bind(planId, tier, cents, now, actor));
  }
  await env.DB.batch(statements);
  return listCommissionRates(env);
}

async function reportExists(env, period) {
  const row = await env.DB.prepare('SELECT period FROM ambassador_payout_reports WHERE period = ?').bind(period).first();
  return Boolean(row);
}

/** A frozen month cannot take new lines; late accruals land in the next open month. */
export async function openPeriodFor(env, period) {
  let candidate = period;
  for (let guard = 0; guard < 24 && await periodClosedForAccrual(env, candidate); guard += 1) candidate = shiftPeriod(candidate, 1);
  return candidate;
}

export async function periodClosedForAccrual(env, period) {
  const row = await env.DB.prepare(`
    SELECT 1 AS closed
    FROM ambassador_payout_reports WHERE period = ?
    UNION ALL
    SELECT 1 AS closed
    FROM ambassador_payout_period_locks WHERE period = ?
    LIMIT 1
  `).bind(period, period).first();
  return Boolean(row);
}

export async function recordPaidCoverage(env, shopId, startsAt, endsAt = null, { source = 'stripe' } = {}) {
  const start = startsAt instanceof Date ? startsAt.toISOString() : new Date(startsAt).toISOString();
  const end = endsAt ? (endsAt instanceof Date ? endsAt.toISOString() : new Date(endsAt).toISOString()) : null;
  return env.DB.prepare(`
    INSERT INTO ambassador_paid_coverage (shop_id, starts_at, ends_at, source, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, starts_at) DO UPDATE SET
      ends_at = COALESCE(excluded.ends_at, ambassador_paid_coverage.ends_at),
      source = excluded.source
  `).bind(shopId, start, end, source, new Date().toISOString()).run();
}

const ELIGIBLE_SQL = `
  SELECT s.shop_id, s.plan_id, s.sale_source, s.sold_by_ambassador_id AS ambassador_id,
         r.tier, r.monthly_cents
  FROM subscriptions s
  INNER JOIN ambassadors a ON a.id = s.sold_by_ambassador_id AND a.status = 'approved'
  INNER JOIN ambassador_commission_rates r ON r.plan_id = s.plan_id
  LEFT JOIN accounts acct ON acct.shop_id = s.shop_id
  WHERE s.status = 'active'
    AND COALESCE(acct.suspended, 0) = 0
    AND (s.current_period_end IS NULL OR s.current_period_end >= ?)
    AND (s.attributed_at IS NULL OR s.attributed_at < ?)
    AND EXISTS (
      SELECT 1 FROM ambassador_paid_coverage paid
      WHERE paid.shop_id = s.shop_id
        AND paid.starts_at < ?
        AND (paid.ends_at IS NULL OR paid.ends_at > ?)
    )
`;

/**
 * Accrue one line per eligible shop for `period`. Idempotent (UNIQUE shop_id,
 * period), so re-running the cron or racing invoice.paid never double-pays.
 */
export async function generateCommissionLedger(env, period, { accruedVia = 'cron', closingPeriod = false } = {}) {
  requirePeriod(period);
  if (await reportExists(env, period) || (!closingPeriod && await periodClosedForAccrual(env, period))) {
    return { period, created: 0, eligible: 0, frozen: true };
  }
  const { start, end } = periodBounds(period);
  const eligible = await env.DB.prepare(`${ELIGIBLE_SQL}`).bind(start, end, end, start).all();
  const now = new Date().toISOString();
  const rows = eligible.results || [];
  if (!rows.length) return {
    period, created: 0, eligible: 0,
    frozen: !closingPeriod && await periodClosedForAccrual(env, period),
  };
  const results = await env.DB.batch(rows.map(row => env.DB.prepare(`
    INSERT INTO ambassador_commissions (
      id, ambassador_id, shop_id, period, earning_period, plan_id, tier, sale_source, amount_cents, status, accrued_via, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM ambassador_payout_reports WHERE period = ?)
      AND (? = 1 OR NOT EXISTS (SELECT 1 FROM ambassador_payout_period_locks WHERE period = ?))
    ON CONFLICT(shop_id, earning_period) DO NOTHING
  `).bind(
    crypto.randomUUID(), row.ambassador_id, row.shop_id, period, period, row.plan_id, row.tier,
    row.sale_source || null, Number(row.monthly_cents), accruedVia, now,
    period, Number(closingPeriod), period,
  )));
  const created = results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  const frozen = !closingPeriod && await periodClosedForAccrual(env, period);
  return { period, created, eligible: rows.length, frozen };
}

function recurringInvoiceLine(invoice) {
  const lines = invoice?.lines?.data || [];
  const hasServicePeriod = line => line.period?.start || line.period?.end;
  return lines.find(line => hasServicePeriod(line) && (line.type === 'subscription'
    || line.parent?.type === 'subscription_item_details'
    || line.parent?.subscription_item_details
    || line.subscription_item
    || line.price?.type === 'recurring'
    || line.price?.recurring))
    || lines.find(hasServicePeriod)
    || null;
}

function invoiceServicePeriod(invoice) {
  const line = recurringInvoiceLine(invoice);
  const startSeconds = Number(line?.period?.start || invoice?.period_start || invoice?.created || 0);
  const endSeconds = Number(line?.period?.end || invoice?.period_end || 0);
  const start = startSeconds > 0 ? new Date(startSeconds * 1000) : new Date();
  const end = endSeconds > 0 ? new Date(endSeconds * 1000) : null;
  return { start, end };
}

async function reconcilePaidInvoiceSubscription(env, shopId, invoice) {
  const stripeSubscriptionId = typeof invoice?.subscription === 'string'
    ? invoice.subscription
    : invoice?.subscription?.id || invoice?.parent?.subscription_details?.subscription || '';
  if (!stripeSubscriptionId) return;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE subscriptions SET status = 'active', updated_at = ?
    WHERE shop_id = ? AND stripe_subscription_id = ? AND status IN ('past_due', 'unpaid', 'incomplete')
  `).bind(now, shopId, stripeSubscriptionId).run();
  if (Number(result?.meta?.changes || 0) > 0) {
    await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET subscription_status = ?, updated_at = ? WHERE shop_id = ?').bind('active', now, shopId),
      env.DB.prepare('UPDATE shops SET billing_status = ?, updated_at = ? WHERE id = ?').bind('active', now, shopId),
    ]);
  }
}

/** Stripe invoice.paid: accrue the month the invoice covers if it charged money. */
export async function recordInvoiceCommission(env, shopId, invoice) {
  if (!(Number(invoice?.amount_paid) > 0)) return { recorded: false, reason: 'zero_amount' };
  await reconcilePaidInvoiceSubscription(env, shopId, invoice);
  const subscription = await env.DB.prepare(`
    SELECT s.plan_id, s.sale_source, s.status AS subscription_status,
           s.sold_by_ambassador_id AS ambassador_id, a.status AS ambassador_status,
           COALESCE(acct.suspended, 0) AS account_suspended,
           r.tier, r.monthly_cents
    FROM subscriptions s
    LEFT JOIN ambassadors a ON a.id = s.sold_by_ambassador_id
    LEFT JOIN ambassador_commission_rates r ON r.plan_id = s.plan_id
    LEFT JOIN accounts acct ON acct.shop_id = s.shop_id
    WHERE s.shop_id = ?
  `).bind(shopId).first();
  if (subscription?.subscription_status !== 'active') return { recorded: false, reason: 'membership_not_active' };
  if (Number(subscription.account_suspended) === 1) return { recorded: false, reason: 'account_suspended' };
  if (!subscription?.ambassador_id) return { recorded: false, reason: 'no_ambassador' };
  if (subscription.ambassador_status !== 'approved') return { recorded: false, reason: 'ambassador_not_approved' };
  if (subscription.monthly_cents === null || subscription.monthly_cents === undefined) return { recorded: false, reason: 'no_rate' };
  const servicePeriod = invoiceServicePeriod(invoice);
  const earningPeriod = periodOf(servicePeriod.start);
  await recordPaidCoverage(env, shopId, servicePeriod.start, servicePeriod.end, { source: 'stripe_invoice' });
  let period = earningPeriod;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    period = await openPeriodFor(env, period);
    const result = await env.DB.prepare(`
      INSERT INTO ambassador_commissions (
        id, ambassador_id, shop_id, period, earning_period, plan_id, tier, sale_source, amount_cents, status, accrued_via, stripe_invoice_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'invoice_paid', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM ambassador_payout_reports WHERE period = ?)
        AND NOT EXISTS (SELECT 1 FROM ambassador_payout_period_locks WHERE period = ?)
      ON CONFLICT(shop_id, earning_period) DO NOTHING
    `).bind(
      crypto.randomUUID(), subscription.ambassador_id, shopId, period, earningPeriod, subscription.plan_id, subscription.tier,
      subscription.sale_source || null, Number(subscription.monthly_cents), String(invoice?.id || '') || null,
      new Date().toISOString(), period, period,
    ).run();
    if (Number(result?.meta?.changes || 0) > 0) return { recorded: true, period };
    const existing = await env.DB.prepare(
      'SELECT period FROM ambassador_commissions WHERE shop_id = ? AND earning_period = ?',
    ).bind(shopId, earningPeriod).first();
    if (existing) return { recorded: false, period: existing.period };
    if (await periodClosedForAccrual(env, period)) {
      period = shiftPeriod(period, 1);
      continue;
    }
    return { recorded: false, period };
  }
  throw new HttpError(503, 'Could not find an open payout period for this invoice');
}

function commissionWhere({ period = '', ambassadorId = '', from = '', to = '', status = '' } = {}) {
  const where = [];
  const args = [];
  if (period) { where.push('c.period = ?'); args.push(requirePeriod(period)); }
  if (from) { where.push('c.period >= ?'); args.push(requirePeriod(from)); }
  if (to) { where.push('c.period <= ?'); args.push(requirePeriod(to)); }
  if (ambassadorId) { where.push('c.ambassador_id = ?'); args.push(String(ambassadorId)); }
  if (status) { where.push('c.status = ?'); args.push(String(status)); }
  return { where, args };
}

export async function listCommissions(env, filters = {}, { page = 1, pageSize = 100 } = {}) {
  const { where, args } = commissionWhere(filters);
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePageSize = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || 100)));
  const rows = await env.DB.prepare(`
    SELECT c.*, acct.shop_name, a.name AS ambassador_name, a.ambassador_number, a.referral_code
    FROM ambassador_commissions c
    LEFT JOIN accounts acct ON acct.shop_id = c.shop_id
    LEFT JOIN ambassadors a ON a.id = c.ambassador_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.period DESC, a.ambassador_number, acct.shop_name
    LIMIT ? OFFSET ?
  `).bind(...args, safePageSize, (safePage - 1) * safePageSize).all();
  return (rows.results || []).map(commissionView);
}

export async function summarizeCommissionsFor(env, filters = {}) {
  const { where, args } = commissionWhere(filters);
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN c.status != 'void' THEN 1 ELSE 0 END) AS lines,
      SUM(CASE WHEN c.status != 'void' THEN c.amount_cents ELSE 0 END) AS earned_cents,
      SUM(CASE WHEN c.status = 'paid' THEN c.amount_cents ELSE 0 END) AS paid_cents,
      SUM(CASE WHEN c.status NOT IN ('paid', 'void') THEN c.amount_cents ELSE 0 END) AS pending_cents
    FROM ambassador_commissions c
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `).bind(...args).first();
  return {
    paginationTotal: Number(row?.total || 0),
    totals: {
      earnedCents: Number(row?.earned_cents || 0),
      paidCents: Number(row?.paid_cents || 0),
      pendingCents: Number(row?.pending_cents || 0),
      lines: Number(row?.lines || 0),
    },
  };
}
export function commissionView(row) {
  return {
    id: row.id,
    ambassadorId: row.ambassador_id,
    ambassadorNumber: row.ambassador_number || '',
    ambassadorName: row.ambassador_name || '',
    shopId: row.shop_id,
    shopName: row.shop_name || row.shop_id,
    period: row.period,
    planId: row.plan_id,
    tier: row.tier,
    saleSource: row.sale_source || '',
    amountCents: Number(row.amount_cents),
    status: row.status,
    accruedVia: row.accrued_via,
    checkNumber: row.check_number || '',
    paidAt: row.paid_at || '',
    createdAt: row.created_at,
  };
}

export function summarizeCommissions(lines) {
  const totals = { earnedCents: 0, paidCents: 0, pendingCents: 0, lines: 0 };
  for (const line of lines) {
    if (line.status === 'void') continue;
    totals.lines += 1;
    totals.earnedCents += line.amountCents;
    if (line.status === 'paid') totals.paidCents += line.amountCents;
    else totals.pendingCents += line.amountCents;
  }
  return totals;
}
