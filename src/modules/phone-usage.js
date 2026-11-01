/** AI phone minutes panel: this billing period's usage against the plan's bucket. */

const dollars = cents => `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;
const shortDate = iso => {
  const time = Date.parse(iso || '');
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
};

/** Plain-language status line for the usage summary from GET /api/phone-usage. */
export function phoneUsageStatus(usage = {}) {
  const included = Number(usage.includedMinutes) || 0;
  const used = Number(usage.usedMinutes) || 0;
  const rate = Number(usage.overageRateCents) || 0;
  if (usage.active === false) return { tone: 'idle', text: 'No active plan: the AI phone agent forwards calls to the shop.' };
  if (usage.capReached) return { tone: 'error', text: `Spending cap of ${dollars(usage.overageCapCents)} reached: calls ring the shop until ${shortDate(usage.periodEnd)}.` };
  if (used > included) return { tone: 'warn', text: `${used - included} minutes over the plan, billed at ${rate}¢/min: ${dollars(usage.overageChargeCents)} so far.` };
  if (included && used >= included * 0.8) return { tone: 'warn', text: `${Math.max(0, included - used)} included minutes left. Extra minutes bill at ${rate}¢/min.` };
  return { tone: 'ready', text: `${Math.max(0, included - used)} included minutes left this period.` };
}

export function phoneUsagePanelHtml(usage, { canEdit = false, escapeHtml = v => String(v ?? ''), icon = () => '' } = {}) {
  if (!usage) return '<section class="settings-panel phone-usage-panel" id="phone-usage-panel"><div class="eyebrow">AI phone minutes</div><p class="ops-note">Loading usage…</p></section>';
  if (usage.error) return `<section class="settings-panel phone-usage-panel" id="phone-usage-panel"><div class="eyebrow">AI phone minutes</div><p class="ops-note">${escapeHtml(usage.error)}</p></section>`;
  const included = Number(usage.includedMinutes) || 0;
  const used = Number(usage.usedMinutes) || 0;
  const percent = included ? Math.min(100, Math.round((used / included) * 100)) : 0;
  const status = phoneUsageStatus(usage);
  const capValue = usage.overageCapCents === null || usage.overageCapCents === undefined ? '' : (Number(usage.overageCapCents) / 100).toFixed(2);
  const capForm = canEdit
    ? `<form class="form-grid" id="phone-usage-cap-form"><label>Overage spending cap (USD per month)<input name="cap" type="number" min="0" step="0.01" inputmode="decimal" placeholder="No cap" value="${escapeHtml(capValue)}"></label><p class="ops-note">Leave blank for no cap. Set 0 to stop at the included minutes. When the cap is hit, calls ring the shop instead of the AI.</p><div class="messaging-actions"><button class="secondary" type="submit">${icon('save', 14)} Save cap</button></div></form>`
    : '';
  return `<section class="settings-panel phone-usage-panel" id="phone-usage-panel">
    <div class="statement-head"><div><div class="eyebrow">AI phone minutes · ${escapeHtml(usage.planName || '')}</div><h2>${used.toLocaleString('en-US')} of ${included.toLocaleString('en-US')} minutes used</h2><p>${escapeHtml(shortDate(usage.periodStart))} – ${escapeHtml(shortDate(usage.periodEnd))} · ${Number(usage.calls) || 0} ${Number(usage.calls) === 1 ? 'call' : 'calls'} · each call rounds up to the next minute</p></div>${icon('phone-call', 20)}</div>
    <div class="usage-meter" role="meter" aria-label="AI phone minutes used" aria-valuemin="0" aria-valuemax="${included}" aria-valuenow="${Math.min(used, included)}"><span style="width:${percent}%"></span></div>
    <div class="messaging-status ${status.tone}">${icon(status.tone === 'ready' ? 'circle-check' : 'triangle-alert', 17)}<div><strong>${escapeHtml(status.text)}</strong><span>Overage rate on your plan: ${Number(usage.overageRateCents) || 0}¢ per minute.</span></div></div>
    ${capForm}
  </section>`;
}

/** Form value (dollars, blank = no cap) to the API's overageCapCents. */
export function capCentsFromInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a cap of $0 or more, or leave it blank for no cap');
  return Math.round(amount * 100);
}
