/**
 * Bulk payment import panel for the Import records page. Pure HTML builders;
 * the Worker (/api/payments/import) does all parsing and validation.
 */

export const PAYMENT_IMPORT_ROLES = ['owner', 'admin'];

export const PAYMENT_IMPORT_TEMPLATE = [
  'invoice_number,amount,date_received,payment_method,reference,note',
  'INV-2042,108.25,2026-09-15,check,CHK-1182,',
  'INV-2043,50.00,09/18/2026,card,AUTH-55821,Deposit',
].join('\n');

const METHOD_LABELS = { cash: 'Cash', check: 'Check', card: 'Card', bank: 'Bank / ACH', processor: 'Processor', other: 'Other' };

const defaults = {
  escapeHtml: value => String(value ?? ''),
  icon: () => '',
  money: value => `$${Number(value || 0).toFixed(2)}`,
};

function skippedTable(skippedRows, { escapeHtml }) {
  if (!skippedRows?.length) return '';
  const body = skippedRows.map(row => `<tr><td>${row.line}</td><td class="mono">${escapeHtml(row.invoiceNumber || '—')}</td><td>${escapeHtml(row.reason)}</td></tr>`).join('');
  return `<div class="import-errors payment-import-skipped"><strong>${skippedRows.length} row${skippedRows.length === 1 ? '' : 's'} will be skipped</strong><div class="data-panel"><table><thead><tr><th>Line</th><th>Invoice</th><th>Reason</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function rowsTable(rows, { escapeHtml, money }) {
  const body = rows.map(row => `<tr${row.warnings.length ? ' class="has-warning"' : ''}><td>${row.line}</td><td class="mono"><b>${escapeHtml(row.invoiceNumber)}</b></td><td>${escapeHtml(row.customer || '—')}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(METHOD_LABELS[row.method] || row.method)}${row.reference ? `<small>${escapeHtml(row.reference)}</small>` : ''}</td><td><b>${money(row.amount)}</b></td><td>${row.warnings.map(warning => `<span class="payment-import-warning">${escapeHtml(warning)}</span>`).join('') || '—'}</td></tr>`).join('');
  return `<div class="data-panel"><table><thead><tr><th>Line</th><th>Invoice</th><th>Customer</th><th>Received</th><th>Method</th><th>Amount</th><th>Warnings</th></tr></thead><tbody>${body || '<tr><td colspan="7">No rows in this file can be posted.</td></tr>'}</tbody></table></div>`;
}

/** state: null | { fileName, busy, preview, dryRun, result, error } */
export function paymentImportPanelHtml(state, helpers = {}) {
  const { escapeHtml, icon, money } = { ...defaults, ...helpers };
  const head = `<div class="statement-head"><div><div class="eyebrow">After an invoice migration</div><h2>Import payments</h2><p>Upload a CSV of payments for invoices already in ShopCrank. Each row is checked against the invoice balance and existing payments, and nothing is saved until you confirm.</p></div>${icon('banknote', 20)}</div>`;
  const columns = '<p class="import-columns">Required: invoice_number, amount, date_received, payment_method · Optional: reference, note. A reference (check number, card authorization) stops the same payment from being posted twice.</p>';
  const picker = `<input id="payment-import-input" type="file" accept=".csv,text/csv" hidden/><div class="import-preview-actions"><button class="secondary" id="payment-import-choose" ${state?.busy ? 'disabled' : ''}>${icon('upload', 14)} Choose payments CSV</button><button class="template-link" id="payment-import-template">${icon('download', 13)} Template</button></div>`;
  const error = state?.error ? `<p class="login-error">${escapeHtml(state.error)}</p>` : '';

  if (state?.result) {
    const result = state.result;
    const posted = result.mode === 'commit';
    const title = posted
      ? `${result.posted} payment${result.posted === 1 ? '' : 's'} posted`
      : `Dry run: ${result.wouldPost} payment${result.wouldPost === 1 ? '' : 's'} would post`;
    const detail = posted
      ? `${money(result.totals.amount)} across ${result.invoicesUpdated} invoice${result.invoicesUpdated === 1 ? '' : 's'} · ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped. Logged to the audit trail.`
      : `${money(result.totals.amount)} validated · ${result.skipped} row${result.skipped === 1 ? '' : 's'} would be skipped. Nothing was saved.`;
    const actions = posted
      ? `<button class="primary" id="payment-import-done">${icon('check', 15)} Done</button>`
      : `<button class="secondary" id="payment-import-cancel">Cancel</button><button class="primary" id="payment-import-commit" ${state.busy || !result.wouldPost ? 'disabled' : ''}>${icon('check', 15)} Post ${result.wouldPost} payments</button>`;
    return `<section class="settings-panel payment-import">${head}<div class="messaging-status ${posted ? 'ready' : 'idle'}">${icon(posted ? 'circle-check' : 'flask-conical', 17)}<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div></div>${error}<div class="import-preview-actions">${actions}</div>${skippedTable(result.skippedRows, { escapeHtml })}</section>`;
  }

  if (state?.preview) {
    const { totals, rows, skippedRows } = state.preview;
    const summary = `<div><div class="eyebrow">${escapeHtml(state.fileName || 'payments.csv')}</div><h3>${totals.valid} of ${totals.rows} payment${totals.rows === 1 ? '' : 's'} ready · ${money(totals.amount)}</h3><p>${totals.invoices} invoice${totals.invoices === 1 ? '' : 's'}${totals.warnings ? ` · ${totals.warnings} with warnings to review` : ''}${totals.skipped ? ` · ${totals.skipped} skipped` : ''}. Posting is all or nothing.</p></div>`;
    const actions = `<div class="import-preview-actions"><button class="secondary" id="payment-import-cancel" ${state.busy ? 'disabled' : ''}>Cancel</button><button class="secondary" id="payment-import-dry-run" ${state.busy || !totals.valid ? 'disabled' : ''}>${icon('flask-conical', 14)} Dry run</button><button class="primary" id="payment-import-commit" ${state.busy || !totals.valid ? 'disabled' : ''}>${icon('check', 15)} Post ${totals.valid} payments</button></div>`;
    return `<section class="settings-panel payment-import">${head}${error}<div class="import-preview">${summary}${actions}</div>${rowsTable(rows, { escapeHtml, money })}${skippedTable(skippedRows, { escapeHtml })}</section>`;
  }

  return `<section class="settings-panel payment-import">${head}${columns}${error}${picker}${state?.busy ? '<p class="ops-note">Checking the file…</p>' : ''}</section>`;
}

export function paymentImportConfirmText(preview) {
  const { totals } = preview;
  return `Post ${totals.valid} payment${totals.valid === 1 ? '' : 's'} totaling $${Number(totals.amount).toFixed(2)} to ${totals.invoices} invoice${totals.invoices === 1 ? '' : 's'}?${totals.skipped ? ` ${totals.skipped} row${totals.skipped === 1 ? '' : 's'} will be skipped.` : ''} This cannot be undone from the import screen.`;
}
