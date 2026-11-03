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
