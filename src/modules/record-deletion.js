/**
 * Record deletion rules shared by the PWA and the Worker.
 *
 * Customers, vehicles, work orders, invoices and payments can only be deleted
 * by the shop owner or an admin. A customer with history can be deleted
 * together with everything linked to it, but only when the caller asks for
 * that explicitly (the PWA requires the owner to type the customer's name).
 */

export const RECORD_DELETE_ROLES = Object.freeze(['owner', 'admin', 'super_admin']);

/** Entity types whose DELETE is limited to RECORD_DELETE_ROLES. */
export const ADMIN_DELETE_TYPES = Object.freeze(new Set(['customers', 'vehicles', 'orders', 'invoices', 'payments']));

export const RECORD_DELETE_DENIED = 'Only the shop owner or an admin can delete customers, vehicles, work orders, and invoices';

export function canDeleteRecords(role) {
  return RECORD_DELETE_ROLES.includes(String(role || ''));
}

export function requiresAdminDelete(type) {
  return ADMIN_DELETE_TYPES.has(String(type || ''));
}

/** Types removed with a customer, matched on their `customer` field (the customer's name). */
export const CUSTOMER_LINKED_TYPES = Object.freeze(['vehicles', 'orders', 'invoices', 'estimates', 'payments', 'appointments']);

const LINK_LABELS = {
  vehicles: ['vehicle', 'vehicles'],
  orders: ['work order', 'work orders'],
  invoices: ['invoice', 'invoices'],
  estimates: ['estimate', 'estimates'],
  payments: ['payment', 'payments'],
  appointments: ['appointment', 'appointments'],
};

function sameText(a, b) {
  return String(a ?? '').trim() !== '' && String(a ?? '').trim() === String(b ?? '').trim();
}

/**
 * Records linked to a customer, from in-memory collections keyed by entity type.
 * Payments are linked by customer name or by belonging to one of the customer's invoices.
 */
export function customerLinkedRecords(customer, collections = {}) {
  const name = customer?.name;
  const linked = {};
  for (const type of CUSTOMER_LINKED_TYPES) {
    const rows = Array.isArray(collections[type]) ? collections[type] : [];
    linked[type] = rows.filter(row => sameText(row?.customer, name));
  }
  const invoiceNumbers = new Set(linked.invoices.map(invoice => String(invoice.number || invoice.id || '')).filter(Boolean));
  const payments = Array.isArray(collections.payments) ? collections.payments : [];
  for (const payment of payments) {
    if (!linked.payments.includes(payment) && invoiceNumbers.has(String(payment?.invoiceNumber || ''))) linked.payments.push(payment);
  }
  return linked;
}

/** "2 vehicles, 1 work order and 3 invoices" — empty string when nothing is linked. */
export function describeLinkedCounts(counts = {}) {
  const parts = CUSTOMER_LINKED_TYPES
    .map(type => [type, Number(Array.isArray(counts[type]) ? counts[type].length : counts[type] || 0)])
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${LINK_LABELS[type][count === 1 ? 0 : 1]}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function hasLinkedRecords(counts = {}) {
  return CUSTOMER_LINKED_TYPES.some(type => Number(Array.isArray(counts[type]) ? counts[type].length : counts[type] || 0) > 0);
}

/* ── Archive instead of delete (Nov 2026 delete policy) ────────────────────
   Records with money attached are archived: hidden from everyday lists, kept
   for tax and accounting reports, and restorable by an owner or admin.
   Records with no money attached are permanently deleted. */

/** Types that can be archived (and that list requests hide once archived). */
export const ARCHIVABLE_TYPES = Object.freeze(new Set(['customers', 'vehicles', 'orders', 'invoices', 'payments']));

export const ARCHIVE_FIELDS = Object.freeze(['archivedAt', 'archivedBy', 'archiveReason', 'archiveGroup']);

export function isArchived(record) {
  return Boolean(record && String(record.archivedAt || '').trim());
}

const PAID_STATUSES = new Set(['paid', 'partial', 'partially_paid', 'partially-paid']);

/**
 * An invoice has activity once it was paid, signed, sent through a customer
 * link, or has payments recorded. Only an invoice with none of these is a draft.
 */
export function invoiceHasActivity(invoice = {}, { payments = [], documentLinks = 0 } = {}) {
  if (payments.length > 0 || Number(documentLinks) > 0) return true;
  if (Number(invoice.paid || invoice.amountPaid || 0) > 0) return true;
  if (invoice.signature && (invoice.signature.signatureKey || invoice.signature.signedAt)) return true;
  return PAID_STATUSES.has(String(invoice.status || '').toLowerCase());
}

/**
 * What removing a record does: 'archive' or 'delete'.
 * `related` holds the linked records found for it:
 *   invoices: payments, documentLinks · orders: invoices, payments
 *   vehicles: invoices (on its VIN or its work orders) · customers: invoices, payments
 */
export function removalAction(type, record = {}, related = {}) {
  const count = key => (Array.isArray(related[key]) ? related[key].length : Number(related[key] || 0));
  switch (type) {
    case 'payments': return 'archive';
    case 'invoices': return invoiceHasActivity(record, { payments: related.payments || [], documentLinks: related.documentLinks || 0 }) ? 'archive' : 'delete';
    case 'orders': return count('invoices') || count('payments') ? 'archive' : 'delete';
    case 'vehicles': return count('invoices') ? 'archive' : 'delete';
    case 'customers': return count('invoices') || count('payments') ? 'archive' : 'delete';
    default: return 'delete';
  }
}

export function archivedCopy(record, { actor = '', at = new Date().toISOString(), reason = '', group = '' } = {}) {
  return { ...record, archivedAt: at, archivedBy: actor, archiveReason: reason, ...(group ? { archiveGroup: group } : {}) };
}

export function restoredCopy(record) {
  const copy = { ...record };
  for (const field of ARCHIVE_FIELDS) delete copy[field];
  return copy;
}

const ARCHIVE_REASONS = {
  invoices: 'Invoice was sent, signed or paid',
  payments: 'Payments are financial records',
  orders: 'Work order is linked to an invoice or payment',
  vehicles: 'Vehicle is on an invoiced work order',
  customers: 'Customer has invoices or payments',
};

export function archiveReason(type) {
  return ARCHIVE_REASONS[type] || 'Has financial history';
}

/** Linked records for a removal decision, from in-memory collections (the PWA). */
export function relatedForRemoval(type, record = {}, collections = {}) {
  const list = key => (Array.isArray(collections[key]) ? collections[key] : []);
  const same = (a, b) => String(a ?? '').trim() !== '' && String(a).trim() === String(b ?? '').trim();
  const realVin = vin => /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(vin || '').trim());
  if (type === 'invoices') {
    const number = record.number || record.id;
    // Deposits are recorded against the work order before the invoice exists.
    return { payments: list('payments').filter(p => same(p.invoiceNumber, number) || (record.ro && same(p.workOrderId, record.ro))) };
  }
  if (type === 'orders') {
    return {
      invoices: list('invoices').filter(i => same(i.ro, record.id)),
      payments: list('payments').filter(p => same(p.workOrderId, record.id)),
    };
  }
  if (type === 'vehicles') {
    const orderIds = new Set(list('orders').filter(o => same(o.vehicleId, record.id) || (realVin(record.vin) && same(o.vin, record.vin))).map(o => o.id));
    return { invoices: list('invoices').filter(i => orderIds.has(i.ro) || (realVin(record.vin) && same(i.vin, record.vin))) };
  }
  if (type === 'customers') {
    const linked = customerLinkedRecords(record, collections);
    return { invoices: linked.invoices, payments: linked.payments };
  }
  return {};
}
