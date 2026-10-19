/** Stripe Revenue Recognition sync panel (general import via S3 / CSV). */

export function revrecStatusLabel(status = {}) {
  if (status.unavailable) return 'Revenue Recognition sync unavailable';
  if (!status.stripeConfigured) return 'Connect shop Stripe payments first';
  if (!status.s3Configured) return 'Platform S3 export is not configured yet';
  if (status.enabled) return 'Daily sync enabled';
  return 'Sync disabled';
}

export function revrecReady(status = {}) {
  return Boolean(status.stripeConfigured && status.s3Configured);
}

export function revenueRecognitionPanelHtml(status = {}, {
  canSave = false,
  escapeHtml = v => String(v ?? ''),
  icon = () => '',
} = {}) {
  const enabled = Boolean(status.enabled);
  const ready = revrecReady(status);
  const label = revrecStatusLabel(status);
  const tone = enabled && ready && !status.lastError ? 'ready' : 'idle';
  const lastExport = status.lastExportedAt
    ? new Date(status.lastExportedAt).toLocaleString()
    : 'Never';
  const lastError = status.lastError
    ? `<p class="login-error">${escapeHtml(status.lastError)}</p>`
    : '';
  const folder = status.folderHint || (status.shopId ? `revrec/${status.shopId}/general/` : 'revrec/{shopId}/general/');
  const banner = `<div class="messaging-status ${tone}">${icon(enabled && ready ? 'circle-check' : 'landmark', 17)}<div><strong>${escapeHtml(label)}</strong><span>Last export: ${escapeHtml(lastExport)}${status.lastObjectKey ? ` · ${escapeHtml(status.lastObjectKey)}` : ''}</span></div></div>`;
  const checklist = `<ol class="ops-note revrec-checklist">
    <li>Enable Stripe Revenue Recognition on this shop's Stripe account.</li>
    <li>In Stripe Dashboard → Data Management, add an Amazon S3 connector.</li>
    <li>Point the connector at folder <code>${escapeHtml(folder)}</code> and map it to Revenue Recognition general import.</li>
    <li>Turn on sync below. ShopCrank writes a CSV there daily at 06:00 UTC.</li>
  </ol>`;
  const actions = canSave
    ? `<form class="form-grid" id="revrec-config-form">
        <label class="toggle-field full"><input type="checkbox" name="enabled" ${enabled ? 'checked' : ''}/><span>Sync cash / check / bank payments and service periods to Stripe Revenue Recognition</span></label>
        <label>Currency<input name="currency" maxlength="3" value="${escapeHtml(status.currency || 'usd')}"/></label>
        <div class="full messaging-actions">
          <button class="primary" type="submit">${icon('save', 14)} Save sync settings</button>
          <button class="secondary" type="button" id="revrec-export-now" ${ready ? '' : 'disabled'}>${icon('upload', 14)} Export now</button>
          <button class="secondary" type="button" id="revrec-download-csv">${icon('download', 14)} Download CSV</button>
        </div>
      </form>`
    : '<p class="ops-note">Ask an owner or admin to enable Revenue Recognition sync.</p>';
  return `<section class="settings-panel revrec-panel">
    <div class="statement-head"><div><div class="eyebrow">Accounting</div><h2>Stripe Revenue Recognition</h2><p>Import non-Stripe payments and recognition service periods into this shop's Stripe RevRec reports.</p></div>${icon('book-open', 20)}</div>
    ${banner}
    ${lastError}
    ${checklist}
    ${actions}
    <div id="revrec-sync-status" class="ops-note"></div>
  </section>`;
}
