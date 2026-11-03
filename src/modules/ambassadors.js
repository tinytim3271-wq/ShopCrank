/** Platform console: Ambassador program (/api/admin/ambassador*). */

export const SALE_SOURCES = Object.freeze([
  ['shopcrank_online', 'ShopCrank online'],
  ['ambassador_site', 'Ambassador site'],
  ['ambassador_referral', 'Ambassador referral'],
  ['admin_manual', 'Admin manual'],
  ['ai_agent', 'AI agent'],
]);
export const REPORT_SOURCES = Object.freeze(['shopcrank_online', 'ambassador_site', 'ambassador_referral']);
export const TIERS = Object.freeze([['solo', 'Solo'], ['shop', 'Shop'], ['shop_pro', 'Shop Pro'], ['enterprise', 'Enterprise']]);
export const TABS = Object.freeze([
  ['ambassadors', 'Ambassadors', 'users'],
  ['sales', 'Sales', 'receipt'],
  ['commissions', 'Commissions', 'badge-dollar-sign'],
  ['reports', 'Payout reports', 'file-text'],
]);
const STATUS_BADGE = { approved: 'paid', applied: 'estimate', suspended: 'overdue', pending: 'estimate', paid: 'paid', void: '' };

export function formatCents(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function saleSourceLabel(source) {
  return SALE_SOURCES.find(([id]) => id === source)?.[1] || (source ? source : 'Unattributed');
}

export function tierLabel(tier) {
  return TIERS.find(([id]) => id === tier)?.[1] || tier || '';
}

/** Query string for /admin/ambassador-sales from the filter form. */
export function salesQuery(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ['ambassadorId', 'source', 'from', 'to']) if (filters[key]) params.set(key, filters[key]);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Last full month as YYYY-MM (what the cron reports on). */
export function lastMonth(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function badge(status, escapeHtml) {
  return `<span class="badge ${STATUS_BADGE[status] ?? ''}">${escapeHtml(status || '')}</span>`;
}

export function ambassadorOptions(ambassadors = [], selected = '', { escapeHtml, includeNone = true, noneLabel = 'No ambassador' } = {}) {
  const none = includeNone ? `<option value="">${escapeHtml(noneLabel)}</option>` : '';
  return none + ambassadors
    .filter(item => item.status !== 'suspended' || item.id === selected)
    .map(item => `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(`${item.ambassadorNumber} · ${item.name}`)}${item.status === 'approved' ? '' : ` (${escapeHtml(item.status)})`}</option>`)
    .join('');
}

export function sourceOptions(selected = '', { escapeHtml, includeAll = false } = {}) {
  return (includeAll ? '<option value="">All sources</option>' : '')
    + SALE_SOURCES.map(([id, label]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function ambassadorsTab(data, { escapeHtml, icon }) {
  const rows = (data.ambassadors || []).map(item => `<tr><td><b class="mono">${escapeHtml(item.ambassadorNumber)}</b><small class="mono">${escapeHtml(item.referralCode)}</small></td><td><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.email)}${item.phone ? ` · ${escapeHtml(item.phone)}` : ''}</small></td><td>${badge(item.status, escapeHtml)}</td><td>${escapeHtml(item.territory)}</td><td><b>${item.activeCount}</b><small>${item.salesCount} total</small></td><td><b>${formatCents(item.pendingCents)}</b><small>${formatCents(item.paidCents)} paid</small></td><td><div class="platform-row-actions"><button class="mini-action" type="button" data-amb-edit="${escapeHtml(item.id)}">${icon('pencil', 13)} Edit</button><button class="mini-action" type="button" data-amb-statement="${escapeHtml(item.id)}">${icon('file-text', 13)} Statement</button></div></td></tr>`).join('');
  return `<div class="platform-action-buttons"><button class="primary" type="button" id="amb-new">${icon('user-plus', 15)} New ambassador</button></div><div class="data-panel"><table><thead><tr><th>Ambassador</th><th>Contact</th><th>Status</th><th>Territory</th><th>Active sales</th><th>Pending</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No ambassadors yet. Applications from /ambassador appear here as “applied”.</td></tr>'}</tbody></table></div>`;
}

function salesTab(data, { escapeHtml, icon }) {
  const filters = data.salesFilters || {};
  const rows = (data.sales || []).map(sale => `<tr><td><b>${escapeHtml(sale.shopName)}</b><small class="mono">${escapeHtml(sale.shopId)}</small></td><td>${escapeHtml(tierLabel(sale.planId) || sale.planId)}</td><td>${badge(sale.status, escapeHtml)}${sale.suspended ? '<small>Account suspended</small>' : ''}</td><td>${sale.ambassadorNumber ? `<b class="mono">${escapeHtml(sale.ambassadorNumber)}</b><small>${escapeHtml(sale.ambassadorName)}</small>` : '<small>—</small>'}</td><td>${escapeHtml(saleSourceLabel(sale.saleSource))}<small>${escapeHtml(sale.soldBy)}</small></td><td class="mono">${escapeHtml(String(sale.soldAt || '').slice(0, 10))}</td><td><button class="mini-action" type="button" data-sale-credit="${escapeHtml(sale.shopId)}">${icon('user-check', 13)} Change credit</button></td></tr>`).join('');
  return `<form class="platform-action-buttons" id="amb-sales-filters"><label>Ambassador<select name="ambassadorId"><option value="">All</option><option value="none"${filters.ambassadorId === 'none' ? ' selected' : ''}>No ambassador</option>${ambassadorOptions(data.ambassadors, filters.ambassadorId, { escapeHtml, includeNone: false })}</select></label><label>Source<select name="source">${sourceOptions(filters.source, { escapeHtml, includeAll: true })}</select></label><label>From<input type="date" name="from" value="${escapeHtml(filters.from || '')}"/></label><label>To<input type="date" name="to" value="${escapeHtml(filters.to || '')}"/></label><button class="secondary" type="submit">${icon('filter', 14)} Filter</button></form><div class="data-panel"><table><thead><tr><th>Shop</th><th>Plan</th><th>Status</th><th>Credited ambassador</th><th>Source · sold by</th><th>Sold</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No sales match these filters.</td></tr>'}</tbody></table></div>`;
}

function commissionsTab(data, { escapeHtml, icon }) {
  const rates = (data.rates || []).map(rate => `<label>${escapeHtml(rate.planId)} <small>(${escapeHtml(tierLabel(rate.tier))})</small><input type="number" min="0" step="0.01" name="rate:${escapeHtml(rate.planId)}" data-tier="${escapeHtml(rate.tier)}" value="${(rate.monthlyCents / 100).toFixed(2)}"/></label>`).join('');
  const lines = (data.commissions?.lines || []).map(line => `<tr><td class="mono">${escapeHtml(line.period)}</td><td><b class="mono">${escapeHtml(line.ambassadorNumber)}</b><small>${escapeHtml(line.ambassadorName)}</small></td><td>${escapeHtml(line.shopName)}</td><td>${escapeHtml(tierLabel(line.tier))}</td><td>${escapeHtml(saleSourceLabel(line.saleSource))}</td><td>${badge(line.status, escapeHtml)}${line.checkNumber ? `<small>Check ${escapeHtml(line.checkNumber)}</small>` : ''}</td><td>${formatCents(line.amountCents)}</td></tr>`).join('');
  const totals = data.commissions?.totals;
  return `<h2>Monthly commission rates</h2><form id="amb-rates-form"><div class="form-grid">${rates}</div><div class="platform-action-buttons"><button class="primary" type="submit">${icon('save', 14)} Save rates</button></div></form><p class="ops-note">Paid monthly for each referred shop while its membership stays active and paid. Rate changes apply to new monthly lines; frozen payout reports never change.</p><h2>Commission ledger</h2><form class="platform-action-buttons" id="amb-ledger-form"><label>Month<input type="month" name="period" value="${escapeHtml(data.ledgerPeriod || lastMonth())}"/></label><button class="secondary" type="submit">${icon('search', 14)} Show</button><button class="secondary" type="button" id="amb-ledger-generate">${icon('refresh-cw', 14)} Accrue month</button></form>${totals ? `<div class="platform-kpis"><article><span>Lines</span><strong>${totals.lines}</strong></article><article><span>Earned</span><strong>${formatCents(totals.earnedCents)}</strong></article><article><span>Pending</span><strong>${formatCents(totals.pendingCents)}</strong></article><article><span>Paid</span><strong>${formatCents(totals.paidCents)}</strong></article></div>` : ''}<div class="data-panel"><table><thead><tr><th>Month</th><th>Ambassador</th><th>Shop</th><th>Plan</th><th>Source</th><th>Status</th><th>Amount</th></tr></thead><tbody>${lines || '<tr><td colspan="7">No commission lines for this month.</td></tr>'}</tbody></table></div>`;
}

function reportsTab(data, { escapeHtml, icon }) {
  const rows = (data.reports || []).map(report => `<tr><td><b>${escapeHtml(report.periodLabel)}</b><small class="mono">${escapeHtml(report.period)}</small></td><td>${report.ambassadorCount}</td><td><b>${formatCents(report.grandTotalCents)}</b></td><td>${report.paidCount} of ${report.ambassadorCount} paid</td><td class="mono">${escapeHtml(String(report.generatedAt || '').slice(0, 16).replace('T', ' '))}<small>${escapeHtml(report.generatedBy)}${report.emailStatus ? ` · ${escapeHtml(report.emailStatus)}` : ''}</small></td><td><button class="mini-action" type="button" data-report-view="${escapeHtml(report.period)}">${icon('eye', 13)} View &amp; pay</button></td></tr>`).join('');
  return `<div class="access-note platform-security">${icon('calendar-clock', 15)} Generated automatically on the 1st of each month for the prior month (cron <span class="mono">${escapeHtml(data.schedule || '0 9 1 * *')}</span> UTC) and emailed to the admin. Each report is a frozen snapshot; payouts are marked by hand with the check number.</div><form class="platform-action-buttons" id="amb-report-form"><label>Month<input type="month" name="period" value="${escapeHtml(lastMonth())}"/></label><button class="primary" type="submit">${icon('file-plus', 14)} Generate / open report</button></form><div class="data-panel"><table><thead><tr><th>Month</th><th>Ambassadors</th><th>Grand total</th><th>Payouts</th><th>Generated</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6">No payout reports yet.</td></tr>'}</tbody></table></div>`;
}

export function ambassadorsHtml(data, helpers) {
  if (!data) return '<p>Loading ambassadors…</p>';
  const { escapeHtml, icon } = helpers;
  const tab = TABS.some(([id]) => id === data.tab) ? data.tab : 'ambassadors';
  const tabs = `<div class="platform-action-buttons" role="tablist">${TABS.map(([id, label, iconName]) => `<button type="button" role="tab" class="${id === tab ? 'primary' : 'secondary'}" aria-selected="${id === tab}" data-amb-tab="${id}">${icon(iconName, 14)} ${escapeHtml(label)}</button>`).join('')}</div>`;
  const body = tab === 'sales' ? salesTab(data, helpers)
    : tab === 'commissions' ? commissionsTab(data, helpers)
      : tab === 'reports' ? reportsTab(data, helpers)
        : ambassadorsTab(data, helpers);
  return `${tabs}${data.loading ? '<p class="ops-note">Loading…</p>' : ''}${body}`;
}

export function ambassadorFormHtml(ambassador, { escapeHtml, icon }) {
  const value = key => escapeHtml(ambassador?.[key] || '');
  const status = ambassador?.status || 'approved';
  return `<form class="modal wide" id="amb-form"><div class="modal-head"><h2>${ambassador ? `Edit ${value('ambassadorNumber')}` : 'New ambassador'}</h2><button type="button" class="close" data-close>${icon('x')}</button></div><div class="modal-body"><div class="form-grid"><label>Name *<input name="displayName" required value="${value('name')}"/></label><label>Email *<input name="email" type="email" required value="${value('email')}"/></label><label>Phone<input name="phone" value="${value('phone')}"/></label><label>Status<select name="status">${['applied', 'approved', 'suspended'].map(item => `<option value="${item}"${item === status ? ' selected' : ''}>${item}</option>`).join('')}</select></label><label>Territory<input name="territory" value="${value('territory')}"/></label><label>Referral code<input name="referralCode" value="${value('referralCode')}" placeholder="Auto-generated"/></label><label>Mailing address (for checks)<textarea name="mailingAddress" rows="3">${value('mailingAddress')}</textarea></label><label>Payout method<input name="payoutMethod" value="${escapeHtml(ambassador?.payoutMethod || 'check')}"/></label><label>Payout details (placeholder)<textarea name="payoutDetails" rows="2" placeholder="Payee name, notes. No bank numbers.">${value('payoutDetails')}</textarea></label><label>Notes<textarea name="notes" rows="2">${value('notes')}</textarea></label></div>${ambassador?.application ? `<div class="ledger-note">${icon('clipboard-list', 15)} <b>Application</b><br>Experience: ${escapeHtml(ambassador.application.experience)}<br>Why: ${escapeHtml(ambassador.application.why)}<br>Social reach: ${escapeHtml(ambassador.application.socialReach)}</div>` : ''}<p class="login-error" id="amb-form-error" hidden></p></div><div class="modal-actions">${ambassador ? `<button type="button" class="secondary" id="amb-delete" data-id="${value('id')}">${icon('trash-2', 14)} Delete</button>` : ''}<button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon('save', 14)} Save</button></div></form>`;
}

export function creditFormHtml(sale, ambassadors, log, { escapeHtml, icon }) {
  const history = (log || []).map(entry => `<tr><td class="mono">${escapeHtml(String(entry.createdAt).slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(entry.previousAmbassadorNumber || '—')} → ${escapeHtml(entry.newAmbassadorNumber || '—')}<small>${escapeHtml(saleSourceLabel(entry.previousSource))} → ${escapeHtml(saleSourceLabel(entry.newSource))}</small></td><td>${escapeHtml(entry.changedBy)}<small>${escapeHtml(entry.reason)}</small></td></tr>`).join('');
  return `<form class="modal wide" id="amb-credit-form"><div class="modal-head"><h2>Sale credit · ${escapeHtml(sale.shopName)}</h2><button type="button" class="close" data-close>${icon('x')}</button></div><div class="modal-body"><div class="form-grid"><label>Credited ambassador<select name="ambassadorId">${ambassadorOptions(ambassadors, sale.ambassadorId, { escapeHtml })}</select></label><label>Sale source<select name="saleSource">${sourceOptions(sale.saleSource || 'admin_manual', { escapeHtml })}</select></label><label>Sold by (label)<input name="soldBy" value="${escapeHtml(sale.soldBy)}" placeholder="Defaults to the ambassador"/></label><label>Reason *<input name="reason" required placeholder="Why the credit is changing"/></label></div><div class="ledger-note">${icon('shield-check', 15)} Every change is recorded with who made it and when. Commissions already in a frozen payout report are not moved.</div><h2>Credit history</h2><div class="data-panel"><table><thead><tr><th>When</th><th>Change</th><th>By · reason</th></tr></thead><tbody>${history || '<tr><td colspan="3">No changes recorded.</td></tr>'}</tbody></table></div><p class="login-error" id="amb-credit-error" hidden></p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary" type="submit">${icon('user-check', 14)} Save credit</button></div></form>`;
}

export function statementHtml(statement, { escapeHtml, icon }) {
  const rows = (statement.lines || []).map(line => `<tr><td class="mono">${escapeHtml(line.period)}</td><td>${escapeHtml(line.shopName)}</td><td>${escapeHtml(tierLabel(line.tier))}</td><td>${escapeHtml(saleSourceLabel(line.saleSource))}</td><td>${badge(line.status, escapeHtml)}${line.checkNumber ? `<small>Check ${escapeHtml(line.checkNumber)}</small>` : ''}</td><td>${formatCents(line.amountCents)}</td></tr>`).join('');
  const { ambassador, totals } = statement;
  return `<div class="modal wide"><div class="modal-head"><h2>Statement · ${escapeHtml(ambassador.ambassadorNumber)} ${escapeHtml(ambassador.name)}</h2><button type="button" class="close" data-close>${icon('x')}</button></div><div class="modal-body"><div class="platform-kpis"><article><span>Earned</span><strong>${formatCents(totals.earnedCents)}</strong></article><article><span>Paid</span><strong>${formatCents(totals.paidCents)}</strong></article><article><span>Pending</span><strong>${formatCents(totals.pendingCents)}</strong></article></div><p class="ops-note">Ambassadors can see this at /ambassador with code <span class="mono">${escapeHtml(ambassador.referralCode)}</span> and their email.</p><div class="data-panel"><table><thead><tr><th>Month</th><th>Shop</th><th>Plan</th><th>Source</th><th>Status</th><th>Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No commissions yet.</td></tr>'}</tbody></table></div></div><div class="modal-actions"><button type="button" class="secondary" data-close>Close</button></div></div>`;
}

function payoutTierRateLabel(item) {
  const entries = item.rateBreakdown?.length
    ? item.rateBreakdown
    : item.count && Number.isFinite(Number(item.rateCents))
      ? [{ rateCents: Number(item.rateCents) }]
      : [];
  if (!entries.length) return '—';
  if (entries.length === 1) return formatCents(entries[0].rateCents);
  return `Mixed (${entries.map(entry => formatCents(entry.rateCents)).join(', ')})`;
}

/** View/print dialog for one month, with a mark-paid form per ambassador. */
export function payoutReportDialogHtml(report, { escapeHtml, icon, today = new Date().toISOString().slice(0, 10) }) {
  const tierHead = TIERS.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('');
  const rows = report.ambassadors.map(entry => {
    const tiers = TIERS.map(([tier]) => `<td>${entry.tiers[tier].count}<small>${formatCents(entry.tiers[tier].subtotalCents)} @ ${escapeHtml(payoutTierRateLabel(entry.tiers[tier]))}</small></td>`).join('');
    const sources = REPORT_SOURCES.map(source => `${escapeHtml(saleSourceLabel(source))}: ${entry.sources[source].count}`).join(' · ');
    const pay = entry.payout
      ? `<span class="badge paid">Paid</span><small>Check ${escapeHtml(entry.payout.checkNumber)} · ${escapeHtml(entry.payout.paidOn)}</small>`
      : `<form class="amb-pay-form" data-ambassador="${escapeHtml(entry.ambassadorId)}"><input name="checkNumber" placeholder="Check #" required size="8"/><input name="paidOn" type="date" value="${escapeHtml(today)}" required/><button class="mini-action" type="submit">${icon('badge-check', 13)} Mark paid</button></form>`;
    return `<tr><td><b class="mono">${escapeHtml(entry.ambassadorNumber)}</b><small class="mono">${escapeHtml(entry.referralCode)}</small></td><td><b>${escapeHtml(entry.name)}</b><small>${sources}</small></td>${tiers}<td><b>${formatCents(entry.totalCents)}</b></td><td>${pay}</td></tr>`;
  }).join('');
  const totals = TIERS.map(([tier]) => `<td><b>${report.totals.tiers[tier].count}</b><small>${formatCents(report.totals.tiers[tier].subtotalCents)} @ ${escapeHtml(payoutTierRateLabel(report.totals.tiers[tier]))}</small></td>`).join('');
  return `<div class="modal wide" id="amb-report-dialog" data-period="${escapeHtml(report.period)}"><div class="modal-head"><h2>Ambassador Payout Report · ${escapeHtml(report.periodLabel)}</h2><button type="button" class="close" data-close>${icon('x')}</button></div><div class="modal-body"><div class="platform-kpis"><article><span>Grand total</span><strong>${formatCents(report.totals.grandTotalCents)}</strong></article><article><span>Ambassadors</span><strong>${report.totals.ambassadorCount}</strong></article><article><span>Paid so far</span><strong>${formatCents(report.paidCents)}</strong></article><article><span>By source</span><strong>${REPORT_SOURCES.map(source => report.totals.sources[source].count).join(' / ')}</strong></article></div><div class="platform-action-buttons"><button class="secondary" type="button" id="amb-report-print">${icon('printer', 14)} Print</button><button class="secondary" type="button" id="amb-report-pdf">${icon('download', 14)} Download PDF</button></div><div class="data-panel"><table><thead><tr><th>Ambassador</th><th>Name · sources</th>${tierHead}<th>Total due</th><th>Payout</th></tr></thead><tbody>${rows || `<tr><td colspan="${TIERS.length + 4}">No ambassador commissions this month.</td></tr>`}</tbody><tfoot><tr><td colspan="2"><b>All ambassadors</b><small>Sources: ${REPORT_SOURCES.map(source => `${escapeHtml(saleSourceLabel(source))} ${formatCents(report.totals.sources[source].amountCents)}`).join(' · ')}</small></td>${totals}<td><b>${formatCents(report.totals.grandTotalCents)}</b></td><td></td></tr></tfoot></table></div><p class="ops-note">Snapshot generated ${escapeHtml(String(report.generatedAt).slice(0, 16).replace('T', ' '))} UTC by ${escapeHtml(report.generatedBy)}. It will not change; marking a check paid is recorded alongside it.</p></div><div class="modal-actions"><button type="button" class="secondary" data-close>Close</button></div></div>`;
}
