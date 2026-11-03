// Monthly Ambassador Payout Report. Built from the commission ledger, stored
// once per month as a frozen snapshot, and rendered as print HTML or PDF.
// Mark-paid data (check number/date) lives beside the snapshot, never in it.

import { HttpError } from '../http.mjs';
import { COMMISSION_TIERS, TIER_LABELS, generateCommissionLedger, periodBounds, periodHasEnded, previousPeriod, requirePeriod } from './commissions.mjs';
import { SALE_SOURCE_LABELS } from './store.mjs';
import { buildPdf } from './pdf.mjs';

export const AMBASSADOR_PAYOUT_CRON = '0 9 1 * *';
export const REPORT_SOURCES = Object.freeze(['shopcrank_online', 'ambassador_site', 'ambassador_referral']);
const OTHER_SOURCE = 'other';
const DEFAULT_FROM = 'noreply@shopcrank.com';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function formatCents(cents) {
  const value = Number(cents || 0) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function periodLabel(period) {
  const { start } = periodBounds(period);
  return new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function emptyTiers() {
  return Object.fromEntries(COMMISSION_TIERS.map(tier => [tier, { tier, label: TIER_LABELS[tier], count: 0, rateCents: null, rateBreakdown: [], subtotalCents: 0 }]));
}

function emptySources() {
  return Object.fromEntries([...REPORT_SOURCES, OTHER_SOURCE].map(source => [source, {
    source,
    label: SALE_SOURCE_LABELS[source] || 'Admin / AI agent',
    count: 0,
    amountCents: 0,
  }]));
}

/** Pure: group ledger lines into the report shape. */
export function assembleReport({ period, lines, ambassadors, generatedAt, generatedBy }) {
  const byAmbassador = new Map();
  const totals = { tiers: emptyTiers(), sources: emptySources(), grandTotalCents: 0, lineCount: 0 };
  for (const line of lines) {
    if (!byAmbassador.has(line.ambassador_id)) {
      const ambassador = ambassadors.get(line.ambassador_id) || {};
      byAmbassador.set(line.ambassador_id, {
        ambassadorId: line.ambassador_id,
        ambassadorNumber: ambassador.ambassador_number || '',
        referralCode: ambassador.referral_code || '',
        name: ambassador.name || 'Unknown ambassador',
        email: ambassador.email || '',
        phone: ambassador.phone || '',
        mailingAddress: ambassador.mailing_address || '',
        payoutMethod: ambassador.payout_method || 'check',
        tiers: emptyTiers(),
        sources: emptySources(),
        lines: [],
        totalCents: 0,
      });
    }
    const entry = byAmbassador.get(line.ambassador_id);
    const amount = Number(line.amount_cents);
    const tier = COMMISSION_TIERS.includes(line.tier) ? line.tier : 'shop';
    const source = REPORT_SOURCES.includes(line.sale_source) ? line.sale_source : OTHER_SOURCE;
    for (const bucket of [entry, totals]) {
      const tierTotals = bucket.tiers[tier];
      tierTotals.count += 1;
      tierTotals.subtotalCents += amount;
      let rate = tierTotals.rateBreakdown.find(item => item.rateCents === amount);
      if (!rate) {
        rate = { rateCents: amount, count: 0, subtotalCents: 0 };
        tierTotals.rateBreakdown.push(rate);
      }
      rate.count += 1;
      rate.subtotalCents += amount;
      bucket.sources[source].count += 1;
      bucket.sources[source].amountCents += amount;
    }
    entry.totalCents += amount;
    totals.grandTotalCents += amount;
    totals.lineCount += 1;
    entry.lines.push({
      commissionId: line.id,
      shopId: line.shop_id,
      shopName: line.shop_name || line.shop_id,
      planId: line.plan_id,
      tier,
      tierLabel: TIER_LABELS[tier],
      saleSource: line.sale_source || '',
      saleSourceLabel: SALE_SOURCE_LABELS[line.sale_source] || 'Unspecified',
      amountCents: amount,
    });
  }
  const list = [...byAmbassador.values()].sort((a, b) => a.ambassadorNumber.localeCompare(b.ambassadorNumber));
  for (const entry of list) {
    entry.lines.sort((a, b) => a.shopName.localeCompare(b.shopName));
    for (const tier of COMMISSION_TIERS) {
      const rateBreakdown = entry.tiers[tier].rateBreakdown;
      rateBreakdown.sort((a, b) => a.rateCents - b.rateCents);
      if (rateBreakdown.length === 1) entry.tiers[tier].rateCents = rateBreakdown[0].rateCents;
    }
  }
  for (const tier of COMMISSION_TIERS) {
    const rateBreakdown = totals.tiers[tier].rateBreakdown;
    rateBreakdown.sort((a, b) => a.rateCents - b.rateCents);
    if (rateBreakdown.length === 1) totals.tiers[tier].rateCents = rateBreakdown[0].rateCents;
  }
  return {
    period,
    periodLabel: periodLabel(period),
    generatedAt,
    generatedBy,
    ambassadors: list,
    totals: { ...totals, ambassadorCount: list.length },
  };
}

export async function buildPayoutReport(env, period, { generatedBy = 'system', now = new Date() } = {}) {
  const lines = await env.DB.prepare(`
    SELECT c.*, acct.shop_name FROM ambassador_commissions c
    LEFT JOIN accounts acct ON acct.shop_id = c.shop_id
    WHERE c.period = ? AND c.status != 'void'
  `).bind(period).all();
  const ids = [...new Set((lines.results || []).map(line => line.ambassador_id))];
  const ambassadors = new Map();
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT * FROM ambassadors WHERE id = ?').bind(id).first();
    if (row) ambassadors.set(id, row);
  }
  return assembleReport({
    period,
    lines: lines.results || [],
    ambassadors,
    generatedAt: now.toISOString(),
    generatedBy,
  });
}

function snapshotFromRow(row) {
  return row ? { ...JSON.parse(row.report_json), emailStatus: row.email_status || '' } : null;
}

function payoutReportEmailSent(report) {
  return String(report?.emailStatus || '').startsWith('sent:');
}

export async function getPayoutReport(env, period) {
  const row = await env.DB.prepare('SELECT * FROM ambassador_payout_reports WHERE period = ?').bind(requirePeriod(period)).first();
  return snapshotFromRow(row);
}

export async function listPayoutReports(env) {
  const rows = await env.DB.prepare(`
    SELECT r.period, r.grand_total_cents, r.ambassador_count, r.generated_at, r.generated_by, r.email_status,
      (SELECT COUNT(*) FROM ambassador_payouts p WHERE p.period = r.period) AS paid_count
    FROM ambassador_payout_reports r ORDER BY r.period DESC LIMIT 60
  `).all();
  return (rows.results || []).map(row => ({
    period: row.period,
    periodLabel: periodLabel(row.period),
    grandTotalCents: Number(row.grand_total_cents),
    ambassadorCount: Number(row.ambassador_count),
    paidCount: Number(row.paid_count || 0),
    generatedAt: row.generated_at,
    generatedBy: row.generated_by,
    emailStatus: row.email_status || '',
  }));
}

/**
 * Accrue the month's ledger, then freeze it. Returns the existing snapshot
 * unchanged if the month was already generated.
 */
export async function generatePayoutReport(env, period, { generatedBy = 'system', now = new Date() } = {}) {
  requirePeriod(period);
  if (!periodHasEnded(period, now)) throw new HttpError(400, 'A payout report can only be generated after the month ends');
  const existing = await getPayoutReport(env, period);
  if (existing) return { report: existing, created: false };
  await env.DB.prepare(`
    INSERT INTO ambassador_payout_period_closures (period, status, closed_at)
    VALUES (?, 'closing', ?)
    ON CONFLICT(period) DO NOTHING
  `).bind(period, now.toISOString()).run();
  const ledger = await generateCommissionLedger(env, period, { accruedVia: 'cron', allowClosingPeriod: true });
  await env.DB.prepare(`
    UPDATE ambassador_payout_period_closures SET status = 'frozen'
    WHERE period = ? AND status = 'closing'
  `).bind(period).run();
  const report = await buildPayoutReport(env, period, { generatedBy, now });
  report.ledger = { created: ledger.created, eligible: ledger.eligible };
  const result = await env.DB.prepare(`
    INSERT INTO ambassador_payout_reports (period, report_json, grand_total_cents, ambassador_count, generated_at, generated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(period) DO NOTHING
  `).bind(period, JSON.stringify(report), report.totals.grandTotalCents, report.totals.ambassadorCount, report.generatedAt, generatedBy).run();
  if (!Number(result?.meta?.changes)) return { report: await getPayoutReport(env, period), created: false };
  return { report: await getPayoutReport(env, period), created: true };
}

export async function listPayouts(env, period) {
  const rows = await env.DB.prepare('SELECT * FROM ambassador_payouts WHERE period = ?').bind(period).all();
  return Object.fromEntries((rows.results || []).map(row => [row.ambassador_id, {
    amountCents: Number(row.amount_cents),
    checkNumber: row.check_number,
    paidOn: row.paid_on,
    markedBy: row.marked_by,
    markedAt: row.marked_at,
  }]));
}

/** Snapshot plus current payout marks, for the admin dialog. */
export async function reportWithPayouts(env, period) {
  const report = await getPayoutReport(env, period);
  if (!report) return null;
  const payouts = await listPayouts(env, period);
  return {
    ...report,
    ambassadors: report.ambassadors.map(entry => ({ ...entry, payout: payouts[entry.ambassadorId] || null })),
    paidCents: Object.values(payouts).reduce((sum, payout) => sum + payout.amountCents, 0),
  };
}

export async function markAmbassadorPaid(env, period, ambassadorId, { checkNumber, paidOn, actor }) {
  const report = await getPayoutReport(env, period);
  if (!report) throw new HttpError(404, 'Generate this month\'s payout report first');
  const entry = report.ambassadors.find(item => item.ambassadorId === ambassadorId);
  if (!entry) throw new HttpError(404, 'This ambassador has no commission in that report');
  const check = String(checkNumber || '').trim().slice(0, 40);
  const date = String(paidOn || '').trim();
  if (!check) throw new HttpError(400, 'Check number is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, 'Paid date must be YYYY-MM-DD');
  const now = new Date().toISOString();
  const ids = entry.lines.map(line => line.commissionId);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO ambassador_payouts (period, ambassador_id, amount_cents, check_number, paid_on, marked_by, marked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period, ambassador_id) DO UPDATE SET check_number = excluded.check_number,
        paid_on = excluded.paid_on, marked_by = excluded.marked_by, marked_at = excluded.marked_at
    `).bind(period, ambassadorId, entry.totalCents, check, date, actor, now),
    ...ids.map(id => env.DB.prepare(`
      UPDATE ambassador_commissions SET status = 'paid', check_number = ?, paid_at = ? WHERE id = ? AND status != 'void'
    `).bind(check, date, id)),
  ]);
  return (await listPayouts(env, period))[ambassadorId];
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const nl2br = value => escapeHtml(value).replace(/\r?\n/g, '<br>');

function tierTable(tiers) {
  const rows = COMMISSION_TIERS.map(tier => tiers[tier]).map(item => `<tr><td>${escapeHtml(item.label)}</td><td class="num">${item.count}</td><td class="num">${escapeHtml(tierRateLabel(item))}</td><td class="num">${formatCents(item.subtotalCents)}</td></tr>`).join('');
  return `<table><thead><tr><th>Tier</th><th class="num">Active paid sales</th><th class="num">Rate / month</th><th class="num">Subtotal</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function tierRateEntries(item) {
  return item.rateBreakdown?.length
    ? item.rateBreakdown
    : item.count && Number.isFinite(Number(item.rateCents))
      ? [{ rateCents: Number(item.rateCents), count: item.count }]
      : [];
}

function tierRateLabel(item) {
  const entries = tierRateEntries(item);
  if (!entries.length) return '—';
  if (entries.length === 1) return formatCents(entries[0].rateCents);
  return `Mixed (${entries.map(entry => formatCents(entry.rateCents)).join(', ')})`;
}

function tierRateDetail(item) {
  const entries = tierRateEntries(item);
  if (!entries.length) return '0 sales';
  const breakdown = entries.map(entry => `${entry.count} x ${formatCents(entry.rateCents)}`).join(', ');
  return entries.length === 1 ? breakdown : `Mixed: ${breakdown}`;
}

function tierPdfRows(item) {
  const entries = tierRateEntries(item);
  if (entries.length <= 1) {
    return [{ columns: [item.label, tierRateDetail(item), formatCents(item.subtotalCents)], widths: [150, 150, 100] }];
  }
  return entries.map(entry => ({
    columns: [`${item.label} (mixed)`, `${entry.count} x ${formatCents(entry.rateCents)}`, formatCents(entry.subtotalCents)],
    widths: [150, 150, 100],
  }));
}

function sourceTable(sources) {
  const rows = [...REPORT_SOURCES, OTHER_SOURCE]
    .map(source => sources[source])
    .filter(item => REPORT_SOURCES.includes(item.source) || item.count)
    .map(item => `<tr><td>${escapeHtml(item.label)}</td><td class="num">${item.count}</td><td class="num">${formatCents(item.amountCents)}</td></tr>`).join('');
  return `<table><thead><tr><th>Sale source</th><th class="num">Sales</th><th class="num">Commission</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Print-ready HTML: summary page, then one page per ambassador. */
export function payoutReportHtml(report, { autoPrint = false } = {}) {
  const summaryRows = report.ambassadors.map(entry => `<tr><td class="mono">${escapeHtml(entry.ambassadorNumber)}</td><td class="mono">${escapeHtml(entry.referralCode)}</td><td>${escapeHtml(entry.name)}</td>${COMMISSION_TIERS.map(tier => `<td class="num">${entry.tiers[tier].count}</td>`).join('')}<td class="num"><b>${formatCents(entry.totalCents)}</b></td><td>${entry.payout ? `Check ${escapeHtml(entry.payout.checkNumber)} · ${escapeHtml(entry.payout.paidOn)}` : 'Unpaid'}</td></tr>`).join('');
  const pages = report.ambassadors.map(entry => `
<section class="page">
  <header><div><strong>ShopCrank</strong><span>Ambassador commission statement</span></div><div class="period">${escapeHtml(report.periodLabel)}</div></header>
  <div class="address-block">
    <div class="address"><b>${escapeHtml(entry.name)}</b><br>${entry.mailingAddress ? nl2br(entry.mailingAddress) : '<em>No mailing address on file</em>'}</div>
    <dl><dt>Ambassador #</dt><dd class="mono">${escapeHtml(entry.ambassadorNumber)}</dd><dt>Referral code</dt><dd class="mono">${escapeHtml(entry.referralCode)}</dd><dt>Period</dt><dd>${escapeHtml(report.period)}</dd><dt>Payout</dt><dd>${escapeHtml(entry.payoutMethod)}</dd>${entry.payout ? `<dt>Check #</dt><dd class="mono">${escapeHtml(entry.payout.checkNumber)}</dd><dt>Paid</dt><dd>${escapeHtml(entry.payout.paidOn)}</dd>` : ''}</dl>
  </div>
  <h2>Line items</h2>
  <table><thead><tr><th>Shop</th><th>Plan</th><th>Source</th><th class="num">Commission</th></tr></thead><tbody>${entry.lines.map(line => `<tr><td>${escapeHtml(line.shopName)}</td><td>${escapeHtml(line.tierLabel)}</td><td>${escapeHtml(line.saleSourceLabel)}</td><td class="num">${formatCents(line.amountCents)}</td></tr>`).join('')}</tbody></table>
  <div class="two-col"><div><h2>By tier</h2>${tierTable(entry.tiers)}</div><div><h2>By source</h2>${sourceTable(entry.sources)}</div></div>
  <p class="total">Total due for ${escapeHtml(report.periodLabel)}: <b>${formatCents(entry.totalCents)}</b></p>
</section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ambassador Payout Report · ${escapeHtml(report.periodLabel)}</title>
<meta name="robots" content="noindex">
<style>
  body{font-family:Helvetica,Arial,sans-serif;color:#111;margin:0;background:#f3f4f6}
  .toolbar{padding:12px 24px;background:#111;color:#fff;display:flex;gap:12px;align-items:center}
  .toolbar button{font:inherit;padding:6px 14px;cursor:pointer}
  .page{background:#fff;width:7.5in;min-height:9.5in;margin:24px auto;padding:.5in;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.15)}
  header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:16px}
  header strong{display:block;font-size:20px} header span{color:#555} .period{font-size:18px;font-weight:bold}
  h1{font-size:22px;margin:0 0 8px} h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px;color:#333}
  table{width:100%;border-collapse:collapse;font-size:12px} th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left} th{background:#f5f5f5}
  .num{text-align:right} .mono{font-family:"Courier New",monospace}
  .address-block{display:flex;justify-content:space-between;gap:24px} .address{font-size:14px;line-height:1.5;min-height:1in}
  dl{display:grid;grid-template-columns:auto auto;gap:2px 12px;font-size:12px;margin:0} dt{color:#555}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px} .total{font-size:18px;text-align:right;margin-top:24px}
  .grand{font-size:20px;text-align:right}
  @media print{body{background:#fff}.toolbar{display:none}.page{margin:0;box-shadow:none;width:auto;min-height:auto;page-break-after:always;padding:0}.page:last-child{page-break-after:auto}}
  @page{size:letter;margin:.5in}
</style></head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">Print</button><span>${escapeHtml(report.periodLabel)} · ${report.totals.ambassadorCount} ambassador${report.totals.ambassadorCount === 1 ? '' : 's'} · ${formatCents(report.totals.grandTotalCents)}</span></div>
<section class="page">
  <header><div><strong>ShopCrank</strong><span>Ambassador Payout Report — summary</span></div><div class="period">${escapeHtml(report.periodLabel)}</div></header>
  <p>Generated ${escapeHtml(new Date(report.generatedAt).toUTCString())} by ${escapeHtml(report.generatedBy)}. Commissions are paid for memberships that stayed active and paid during the month.</p>
  <table><thead><tr><th>Ambassador #</th><th>Code</th><th>Name</th>${COMMISSION_TIERS.map(tier => `<th class="num">${escapeHtml(TIER_LABELS[tier])}</th>`).join('')}<th class="num">Total due</th><th>Payout</th></tr></thead><tbody>${summaryRows || `<tr><td colspan="${COMMISSION_TIERS.length + 5}">No ambassador commissions this month.</td></tr>`}</tbody></table>
  <div class="two-col"><div><h2>All ambassadors by tier</h2>${tierTable(report.totals.tiers)}</div><div><h2>All ambassadors by source</h2>${sourceTable(report.totals.sources)}</div></div>
  <p class="grand">Grand total: <b>${formatCents(report.totals.grandTotalCents)}</b></p>
</section>
${pages}
${autoPrint ? '<script>window.addEventListener("load",()=>window.print())</script>' : ''}
</body></html>`;
}

function pdfAddressLines(entry) {
  const lines = String(entry.mailingAddress || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length ? lines : ['(no mailing address on file)'];
}

/** PDF with the same structure as the print HTML. */
export function payoutReportPdf(report) {
  const pages = [];
  const summary = [
    { text: 'ShopCrank - Ambassador Payout Report', size: 18, bold: true },
    { text: `Period: ${report.periodLabel} (${report.period})`, size: 12 },
    { text: `Generated ${report.generatedAt} by ${report.generatedBy}`, size: 9 },
    { rule: true },
    { columns: ['Amb #', 'Code', 'Name', 'Solo', 'Shop', 'Pro', 'Ent', 'Total due'], widths: [60, 60, 150, 40, 40, 40, 40, 82], bold: true },
    ...report.ambassadors.map(entry => ({
      columns: [entry.ambassadorNumber, entry.referralCode, entry.name, ...COMMISSION_TIERS.map(tier => String(entry.tiers[tier].count)), formatCents(entry.totalCents)],
      widths: [60, 60, 150, 40, 40, 40, 40, 82],
    })),
    { rule: true },
    { text: 'By tier', size: 11, bold: true },
    ...COMMISSION_TIERS.flatMap(tier => tierPdfRows(report.totals.tiers[tier])),
    { text: 'By source', size: 11, bold: true },
    ...[...REPORT_SOURCES, OTHER_SOURCE].map(source => report.totals.sources[source])
      .filter(item => REPORT_SOURCES.includes(item.source) || item.count)
      .map(item => ({ columns: [item.label, `${item.count} sales`, formatCents(item.amountCents)], widths: [150, 150, 100] })),
    { rule: true },
    { text: `Grand total: ${formatCents(report.totals.grandTotalCents)}`, size: 14, bold: true },
  ];
  pages.push(summary);
  for (const entry of report.ambassadors) {
    pages.push([
      { text: 'ShopCrank - Ambassador Commission Statement', size: 16, bold: true },
      { text: `Period: ${report.periodLabel} (${report.period})`, size: 12 },
      { rule: true },
      { text: entry.name, size: 12, bold: true },
      ...pdfAddressLines(entry).map(line => ({ text: line, size: 11 })),
      { gap: 8 },
      { text: `Ambassador #: ${entry.ambassadorNumber}    Referral code: ${entry.referralCode}    Payout: ${entry.payoutMethod}`, size: 10 },
      ...(entry.payout ? [{ text: `Paid by check ${entry.payout.checkNumber} on ${entry.payout.paidOn}`, size: 10 }] : []),
      { rule: true },
      { columns: ['Shop', 'Plan', 'Source', 'Commission'], widths: [220, 80, 120, 92], bold: true },
      ...entry.lines.map(line => ({ columns: [line.shopName, line.tierLabel, line.saleSourceLabel, formatCents(line.amountCents)], widths: [220, 80, 120, 92] })),
      { rule: true },
      ...COMMISSION_TIERS.flatMap(tier => tierPdfRows(entry.tiers[tier])),
      { gap: 4 },
      ...REPORT_SOURCES.map(source => entry.sources[source]).map(item => ({ columns: [item.label, `${item.count} sales`, formatCents(item.amountCents)], widths: [150, 150, 100] })),
      ...(entry.sources[OTHER_SOURCE].count ? [{ columns: [entry.sources[OTHER_SOURCE].label, `${entry.sources[OTHER_SOURCE].count} sales`, formatCents(entry.sources[OTHER_SOURCE].amountCents)], widths: [150, 150, 100] }] : []),
      { rule: true },
      { text: `Total due: ${formatCents(entry.totalCents)}`, size: 14, bold: true },
    ]);
  }
  return buildPdf(pages, { title: `ShopCrank Ambassador Payout Report ${report.period}` });
}

function emailText(report, origin) {
  const lines = [
    `Ambassador Payout Report for ${report.periodLabel} is ready.`,
    '',
    `Ambassadors: ${report.totals.ambassadorCount}`,
    `Grand total due: ${formatCents(report.totals.grandTotalCents)}`,
    '',
    ...report.ambassadors.map(entry => `${entry.ambassadorNumber}  ${entry.referralCode}  ${entry.name}: ${formatCents(entry.totalCents)}`),
    '',
    `Print or download: ${origin}/api/admin/ambassador-payout-reports/${report.period}/print`,
    `PDF: ${origin}/api/admin/ambassador-payout-reports/${report.period}/pdf`,
    'Mark each check paid from Platform console > Ambassadors > Payout reports.',
  ];
  return lines.join('\n');
}

/** Email the admin through the EMAIL binding when one is configured. */
export async function notifyPayoutReport(env, report) {
  const to = String(env.AMBASSADOR_REPORT_EMAIL_TO || env.SUPPORT_EMAIL_TO || '').trim();
  const from = String(env.AMBASSADOR_REPORT_EMAIL_FROM || env.AUTH_EMAIL_FROM || DEFAULT_FROM).trim();
  let status;
  if (typeof env.EMAIL?.send !== 'function') status = 'email_not_configured';
  else if (!EMAIL_PATTERN.test(to) || !EMAIL_PATTERN.test(from)) status = 'invalid_address';
  else {
    try {
      await env.EMAIL.send({
        to,
        from,
        subject: `[ShopCrank] Ambassador payouts for ${report.periodLabel}: ${formatCents(report.totals.grandTotalCents)}`,
        text: emailText(report, String(env.GOOGLE_REDIRECT_ORIGIN || 'https://www.shopcrank.com').replace(/\/$/, '')),
      });
      status = `sent:${to}`;
    } catch (error) {
      status = `send_failed:${String(error?.message || error).slice(0, 120)}`;
    }
  }
  await env.DB.prepare('UPDATE ambassador_payout_reports SET email_status = ? WHERE period = ?').bind(status, report.period).run();
  return status;
}

/** Cron entry: freeze last month and tell the admin. */
export async function runScheduledAmbassadorPayouts(env, { now = new Date() } = {}) {
  const period = previousPeriod(now);
  const { report, created } = await generatePayoutReport(env, period, { generatedBy: 'cron', now });
  const email = payoutReportEmailSent(report) ? 'skipped_existing' : await notifyPayoutReport(env, report);
  return { period, created, grandTotalCents: report.totals.grandTotalCents, ambassadors: report.totals.ambassadorCount, email };
}
