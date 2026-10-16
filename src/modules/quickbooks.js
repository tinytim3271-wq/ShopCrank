/** QuickBooks Online connect/sync helpers with idempotent mapping. */

export const QUICKBOOKS_SECRET_NAME = 'quickbooks-oauth';
export const QUICKBOOKS_SCOPES = 'com.intuit.quickbooks.accounting';

export function quickbooksConnectionStatus(record) {
  if (!record || typeof record !== 'object') {
    return { connected: false, status: 'not_connected', label: 'QuickBooks Online not connected' };
  }
  const connected = Boolean(record.realmId && (record.refreshToken || record.accessToken));
  if (!connected) {
    return { connected: false, status: 'not_connected', label: 'QuickBooks Online not connected' };
  }
  return {
    connected: true,
    status: 'connected',
    label: 'QuickBooks Online connected',
    realmId: record.realmId,
    connectedAt: record.connectedAt || null,
    tokenExpiresAt: record.tokenExpiresAt || null,
  };
}

export function buildQboIdempotencyKey(shopId, entityType, localId, action = 'upsert') {
  return [String(shopId || ''), String(entityType || ''), String(localId || ''), String(action || 'upsert')]
    .map(part => part.replace(/\|/g, '_'))
    .join('|');
}

export function mapCustomerToQbo(customer = {}) {
  const displayName = String(customer.name || customer.displayName || '').trim();
  if (!displayName) throw new Error('Customer name is required for QuickBooks sync');
  return {
    DisplayName: displayName.slice(0, 500),
    PrimaryEmailAddr: customer.email ? { Address: String(customer.email).trim() } : undefined,
    PrimaryPhone: customer.phone ? { FreeFormNumber: String(customer.phone).trim() } : undefined,
    BillAddr: customer.address ? { Line1: String(customer.address).slice(0, 500) } : undefined,
    Notes: customer.notes ? String(customer.notes).slice(0, 4000) : undefined,
    ...(customer.qboId ? { Id: String(customer.qboId), SyncToken: String(customer.qboSyncToken || '0') } : {}),
  };
}

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

export class QboTaxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QboTaxConfigError';
    this.code = 'QUICKBOOKS_TAX_CONFIG';
  }
}

/**
 * Shop Crank line -> QBO quantity/price/amount. QBO rejects lines where
 * Qty * UnitPrice != Amount, so labor uses hours x rate and any line whose
 * stored total disagrees is sent as one unit at the line total.
 */
export function qboLineMoney(line = {}) {
  const labor = line.type === 'labor' || (line.type === undefined && Number(line.hours) > 0 && line.unitPrice === undefined);
  let qty = labor ? Number(line.hours ?? line.quantity ?? 1) : Number(line.quantity ?? line.qty ?? 1);
  let unitPrice = labor ? Number(line.laborRate ?? line.unitPrice ?? 0) : Number(line.unitPrice ?? line.price ?? 0);
  qty = Number.isFinite(qty) && qty >= 0 ? qty : 1;
  unitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? roundMoney(unitPrice) : 0;
  const stored = line.amount ?? line.total;
  const amount = stored === undefined || stored === null || stored === '' ? roundMoney(qty * unitPrice) : roundMoney(stored);
  if (roundMoney(qty * unitPrice) !== amount) return { qty: 1, unitPrice: amount, amount };
  return { qty, unitPrice, amount };
}

export function qboBillableLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).filter(line => line && line.approvalStatus !== 'declined');
}

/** Detects how a QuickBooks company handles sales tax from Preferences + CompanyInfo. */
export function qboTaxModeFromCompany({ preferences, companyInfo } = {}) {
  const prefs = preferences?.Preferences?.TaxPrefs || preferences?.TaxPrefs || {};
  const country = String(companyInfo?.CompanyInfo?.Country || companyInfo?.Country || 'US').trim().toUpperCase();
  if (!['US', 'USA', 'UNITED STATES'].includes(country)) return 'global';
  if (prefs.PartnerTaxEnabled === true) return 'ast';
  if (prefs.UsingSalesTax === true) return 'manual';
  return 'none';
}

export function qboLineTaxable(line = {}, totalTax = 0) {
  return Number(totalTax) > 0 && line.taxable !== false && line.taxExempt !== true;
}

/**
 * Adds the tax fields QBO requires for the company's tax mode. Missing or
 * wrong tax fields are what produce error 6000 ("business validation"):
 *  - ast (US Automated Sales Tax): line TaxCodeRef TAX/NON, QBO computes tax.
 *  - manual (US, AST off): line TAX/NON plus TxnTaxDetail.TxnTaxCodeRef + TotalTax.
 *  - global (non-US): every line needs a real TaxCode id.
 *  - none: the company does not track sales tax; taxed invoices fail closed.
 * When `tax` is not supplied the payload is returned unchanged.
 */
export function applyQboInvoiceTax(payload, { taxable = [], totalTax = 0, tax = null } = {}) {
  if (!tax) return payload;
  const total = roundMoney(totalTax);
  const salesLines = payload.Line.filter(line => line.DetailType === 'SalesItemLineDetail');
  const flags = salesLines.map((_, index) => Boolean(taxable[index]) && total > 0);
  const anyTaxable = flags.some(Boolean);
  if (tax.mode === 'none') {
    if (total > 0) {
      throw new QboTaxConfigError('This QuickBooks company does not track sales tax, but the invoice has tax. Turn on sales tax in QuickBooks, then sync again.');
    }
    return payload;
  }
  if (tax.mode === 'ast' || tax.mode === 'manual') {
    salesLines.forEach((line, index) => { line.SalesItemLineDetail.TaxCodeRef = { value: flags[index] ? 'TAX' : 'NON' }; });
    if (tax.mode === 'manual' && anyTaxable) {
      if (!tax.taxCodeId) {
        throw new QboTaxConfigError('Choose the QuickBooks sales tax rate for Shop Crank invoices (Integrations → QuickBooks → Tax settings), then sync again.');
      }
      payload.TxnTaxDetail = { TxnTaxCodeRef: { value: String(tax.taxCodeId) }, TotalTax: total };
    }
    return payload;
  }
  if (tax.mode === 'global') {
    if (anyTaxable && !tax.taxCodeId) throw new QboTaxConfigError('Choose the QuickBooks tax code for taxable Shop Crank lines, then sync again.');
    if (flags.some(flag => !flag) && !tax.exemptTaxCodeId) throw new QboTaxConfigError('Choose the QuickBooks tax code for non-taxable Shop Crank lines, then sync again.');
    salesLines.forEach((line, index) => {
      line.SalesItemLineDetail.TaxCodeRef = { value: String(flags[index] ? tax.taxCodeId : tax.exemptTaxCodeId) };
    });
    payload.GlobalTaxCalculation = 'TaxExcluded';
    return payload;
  }
  throw new QboTaxConfigError(`Unknown QuickBooks tax mode: ${tax.mode}`);
}

/** Picks the tax code to use when the shop has not chosen one and the choice is unambiguous. */
export function resolveQboTaxSettings(mode, taxCodes = [], saved = {}) {
  const active = taxCodes.filter(code => code && code.Active !== false);
  const ids = new Set(active.map(code => String(code.Id)));
  const pick = (id) => (id && ids.has(String(id)) ? String(id) : null);
  const taxable = active.filter(code => code.Taxable !== false && !['TAX', 'NON'].includes(String(code.Id)));
  const exempt = active.filter(code => code.Taxable === false && String(code.Id) !== 'NON');
  return {
    mode,
    taxCodeId: pick(saved.taxCodeId) || (taxable.length === 1 ? String(taxable[0].Id) : null),
    exemptTaxCodeId: pick(saved.exemptTaxCodeId) || (exempt.length === 1 ? String(exempt[0].Id) : null),
  };
}

export function mapInvoiceToQbo(invoice = {}, customerRef, { tax = null } = {}) {
  const billable = qboBillableLines(invoice.lines);
  const lines = billable.map((line, index) => {
    const { qty, unitPrice, amount } = qboLineMoney(line);
    const description = String(line.description || line.name || `Line ${index + 1}`);
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: description.slice(0, 4000),
      SalesItemLineDetail: { Qty: qty, UnitPrice: unitPrice },
    };
  });
  if (!lines.length) throw new Error('Invoice needs at least one line for QuickBooks sync');
  if (!customerRef) throw new Error('QuickBooks CustomerRef is required');
  const payload = {
    Line: lines,
    CustomerRef: { value: String(customerRef) },
    DocNumber: String(invoice.number || invoice.id || '').slice(0, 21) || undefined,
    PrivateNote: invoice.ro ? `Shop Crank RO ${invoice.ro}` : undefined,
    ...(invoice.qboId ? { Id: String(invoice.qboId), SyncToken: String(invoice.qboSyncToken || '0') } : {}),
  };
  const totalTax = Number(invoice.tax) || 0;
  return applyQboInvoiceTax(payload, { taxable: billable.map(line => qboLineTaxable(line, totalTax)), totalTax, tax });
}

export function mapPaymentToQbo(payment = {}, customerRef, invoiceRef) {
  const amount = Number(payment.amount ?? payment.total ?? 0) || 0;
  if (amount <= 0) throw new Error('Payment amount must be greater than zero');
  if (!customerRef) throw new Error('QuickBooks CustomerRef is required');
  const line = invoiceRef
    ? [{ Amount: amount, LinkedTxn: [{ TxnId: String(invoiceRef), TxnType: 'Invoice' }] }]
    : undefined;
  return {
    TotalAmt: amount,
    CustomerRef: { value: String(customerRef) },
    Line: line,
    PrivateNote: payment.id ? `Shop Crank payment ${payment.id}` : undefined,
    ...(payment.qboId ? { Id: String(payment.qboId), SyncToken: String(payment.qboSyncToken || '0') } : {}),
  };
}

/** The browser only receives the server's status (never tokens), so trust its `connected` flag. */
export function quickbooksPanelStatus(account = {}) {
  if (account?.connected === true) return { ...account, connected: true, status: 'connected', label: account.label || 'QuickBooks Online connected' };
  return quickbooksConnectionStatus(account);
}

export function quickbooksPanelHtml(account = {}, { canSave = false, escapeHtml = v => String(v ?? ''), icon = () => '' } = {}) {
  const status = quickbooksPanelStatus(account);
  const banner = status.connected
    ? `<div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>Company ${escapeHtml(status.realmId || '')}</span></div></div>`
    : `<div class="messaging-status idle">${icon('landmark', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>Connect QuickBooks Online with OAuth 2.0. Sync stays fail-closed until authorized.</span></div></div>`;
  const actions = canSave
    ? `<div class="messaging-actions">
        ${status.connected
          ? `<button class="secondary" type="button" id="qbo-sync-now">${icon('refresh-cw', 14)} Sync customers / invoices / payments</button>
             <button class="secondary danger" type="button" id="qbo-disconnect">${icon('log-out', 14)} Disconnect QuickBooks</button>`
          : `<button class="primary" type="button" id="qbo-connect">${icon('link', 14)} Connect QuickBooks Online</button>`}
      </div>`
    : '<p class="ops-note">Ask an owner or admin to connect QuickBooks Online.</p>';
  return `<section class="settings-panel quickbooks-panel">
    <div class="statement-head"><div><div class="eyebrow">Accounting</div><h2>QuickBooks Online</h2><p>OAuth connect/disconnect and idempotent sync of customers, invoices, and payments.</p></div>${icon('book', 20)}</div>
    ${banner}
    ${actions}
    <div id="qbo-sync-status" class="ops-note"></div>
  </section>`;
}
