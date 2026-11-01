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
  for (let guard = 0; guard < 24 && await reportExists(env, candidate); guard += 1) candidate = shiftPeriod(candidate, 1);
  return candidate;
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
`;

/**
 * Accrue one line per eligible shop for `period`. Idempotent (UNIQUE shop_id,
 * period), so re-running the cron or racing invoice.paid never double-pays.
 */
export async function generateCommissionLedger(env, period, { accruedVia = 'cron' } = {}) {
  requirePeriod(period);
  if (await reportExists(env, period)) return { period, created: 0, eligible: 0, frozen: true };
  const { start, end } = periodBounds(period);
  const eligible = await env.DB.prepare(`${ELIGIBLE_SQL}`).bind(start, end).all();
  const now = new Date().toISOString();
  const rows = eligible.results || [];
  if (!rows.length) return { period, created: 0, eligible: 0, frozen: false };
  const results = await env.DB.batch(rows.map(row => env.DB.prepare(`
    INSERT INTO ambassador_commissions (
      id, ambassador_id, shop_id, period, plan_id, tier, sale_source, amount_cents, status, accrued_via, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(shop_id, period) DO NOTHING
  `).bind(
    crypto.randomUUID(), row.ambassador_id, row.shop_id, period, row.plan_id, row.tier,
    row.sale_source || null, Number(row.monthly_cents), accruedVia, now,
  )));
  const created = results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  return { period, created, eligible: rows.length, frozen: false };
}

function invoicePeriodStart(invoice) {
  const seconds = Number(invoice?.period_start || invoice?.lines?.data?.[0]?.period?.start || invoice?.created || 0);
  return seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** Stripe invoice.paid: accrue the month the invoice covers if it charged money. */
export async function recordInvoiceCommission(env, shopId, invoice) {
  if (!(Number(invoice?.amount_paid) > 0)) return { recorded: false, reason: 'zero_amount' };
  const subscription = await env.DB.prepare(`
    SELECT s.plan_id, s.sale_source, s.sold_by_ambassador_id AS ambassador_id, a.status AS ambassador_status,
           r.tier, r.monthly_cents
    FROM subscriptions s
    LEFT JOIN ambassadors a ON a.id = s.sold_by_ambassador_id
    LEFT JOIN ambassador_commission_rates r ON r.plan_id = s.plan_id
    WHERE s.shop_id = ?
  `).bind(shopId).first();
  if (!subscription?.ambassador_id) return { recorded: false, reason: 'no_ambassador' };
  if (subscription.ambassador_status !== 'approved') return { recorded: false, reason: 'ambassador_not_approved' };
  if (subscription.monthly_cents === null || subscription.monthly_cents === undefined) return { recorded: false, reason: 'no_rate' };
  const period = await openPeriodFor(env, periodOf(invoicePeriodStart(invoice)));
  const result = await env.DB.prepare(`
    INSERT INTO ambassador_commissions (
      id, ambassador_id, shop_id, period, plan_id, tier, sale_source, amount_cents, status, accrued_via, stripe_invoice_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'invoice_paid', ?, ?)
    ON CONFLICT(shop_id, period) DO NOTHING
  `).bind(
    crypto.randomUUID(), subscription.ambassador_id, shopId, period, subscription.plan_id, subscription.tier,
    subscription.sale_source || null, Number(subscription.monthly_cents), String(invoice?.id || '') || null,
    new Date().toISOString(),
  ).run();
  return { recorded: Number(result?.meta?.changes || 0) > 0, period };
}

export async function listCommissions(env, { period = '', ambassadorId = '', from = '', to = '', status = '' } = {}) {
  const where = [];
  const args = [];
  if (period) { where.push('c.period = ?'); args.push(requirePeriod(period)); }
  if (from) { where.push('c.period >= ?'); args.push(requirePeriod(from)); }
  if (to) { where.push('c.period <= ?'); args.push(requirePeriod(to)); }
  if (ambassadorId) { where.push('c.ambassador_id = ?'); args.push(String(ambassadorId)); }
  if (status) { where.push('c.status = ?'); args.push(String(status)); }
  const rows = await env.DB.prepare(`
    SELECT c.*, acct.shop_name, a.name AS ambassador_name, a.ambassador_number, a.referral_code
    FROM ambassador_commissions c
    LEFT JOIN accounts acct ON acct.shop_id = c.shop_id
    LEFT JOIN ambassadors a ON a.id = c.ambassador_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.period DESC, a.ambassador_number, acct.shop_name
    LIMIT 2000
  `).bind(...args).all();
  return (rows.results || []).map(commissionView);
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
