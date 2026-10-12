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

export function mapInvoiceToQbo(invoice = {}, customerRef) {
  const lines = (invoice.lines || []).map((line, index) => {
    const amount = Number(line.total ?? line.amount ?? 0) || 0;
    const description = String(line.description || line.name || `Line ${index + 1}`);
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: description.slice(0, 4000),
      SalesItemLineDetail: {
        Qty: Math.max(0, Number(line.quantity ?? line.hours ?? 1) || 1),
        UnitPrice: Math.max(0, Number(line.unitPrice ?? line.laborRate ?? amount) || 0),
      },
    };
  });
  if (!lines.length) throw new Error('Invoice needs at least one line for QuickBooks sync');
  if (!customerRef) throw new Error('QuickBooks CustomerRef is required');
  return {
    Line: lines,
    CustomerRef: { value: String(customerRef) },
    DocNumber: String(invoice.number || invoice.id || '').slice(0, 21) || undefined,
    PrivateNote: invoice.ro ? `MechPro RO ${invoice.ro}` : undefined,
    ...(invoice.qboId ? { Id: String(invoice.qboId), SyncToken: String(invoice.qboSyncToken || '0') } : {}),
  };
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
    PrivateNote: payment.id ? `MechPro payment ${payment.id}` : undefined,
    ...(payment.qboId ? { Id: String(payment.qboId), SyncToken: String(payment.qboSyncToken || '0') } : {}),
  };
}

export function quickbooksPanelHtml(account = {}, { canSave = false, escapeHtml = v => String(v ?? ''), icon = () => '' } = {}) {
  const status = quickbooksConnectionStatus(account);
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
