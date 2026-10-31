/**
 * Record deletion policy shared by the PWA and the Worker.
 *
 * Only shop owners/admins may remove records. Records that carry financial
 * history are archived (kept, flagged with `archivedAt`) instead of deleted so
 * the books, tax reports, and payment audit trail stay intact.
 */

export const RECORD_DELETE_ROLES = Object.freeze(['owner', 'admin']);

export function canDeleteRecords(role) {
  return RECORD_DELETE_ROLES.includes(String(role || ''));
}

/** Types that are financial records themselves and are never hard-deleted. */
export const ALWAYS_ARCHIVE_TYPES = new Set(['invoices', 'payments', 'expenses', 'payrollentries', 'purchases']);

/** Types whose DELETE keeps its own membership rules (chat housekeeping, not records). */
export const SELF_MANAGED_DELETE_TYPES = new Set(['conversations', 'chatmessages']);

const TYPE_LABELS = {
  customers: 'customer',
  vehicles: 'vehicle',
  orders: 'work order',
  invoices: 'invoice',
  estimates: 'estimate',
  payments: 'payment',
  expenses: 'expense',
  payrollentries: 'payroll entry',
  purchases: 'purchase',
  employees: 'employee',
};

const LINK_LABELS = {
  invoices: 'invoice',
  payments: 'payment',
  orders: 'work order',
  estimates: 'estimate',
  payrollentries: 'payroll entry',
  vehicles: 'vehicle',
};

/**
 * Linked records that make a record financially significant.
 * `field` is read on the linked record; `key` is read on the record being removed.
 */
const FINANCIAL_LINKS = {
  customers: [
    { type: 'invoices', field: 'customer', key: 'name' },
    { type: 'payments', field: 'customer', key: 'name' },
    { type: 'orders', field: 'customer', key: 'name' },
    { type: 'estimates', field: 'customer', key: 'name' },
  ],
  orders: [
    { type: 'invoices', field: 'ro', key: 'id' },
    { type: 'payments', field: 'workOrderId', key: 'id' },
    { type: 'payrollentries', field: 'workOrderId', key: 'id' },
  ],
  estimates: [
    { type: 'payments', field: 'estimateId', key: 'id' },
    { type: 'invoices', field: 'estimateId', key: 'id' },
  ],
  vehicles: [
    { type: 'orders', field: 'vehicleId', key: 'id' },
    { type: 'orders', field: 'vin', key: 'vin' },
    { type: 'invoices', field: 'vin', key: 'vin' },
  ],
  employees: [
    { type: 'payrollentries', field: 'employeeId', key: 'id' },
  ],
};

/** Non-financial links that must be removed first (a customer still owning vehicles). */
const BLOCKING_LINKS = {
  customers: [{ type: 'vehicles', field: 'customer', key: 'name' }],
};

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function intrinsicFinancialReasons(type, record = {}) {
  if (ALWAYS_ARCHIVE_TYPES.has(type)) return [`${TYPE_LABELS[type] || 'record'} is a financial record`];
  const reasons = [];
  const status = String(record.status || '').toLowerCase();
  if (type === 'orders' && ['invoiced', 'paid'].includes(status)) reasons.push('work order has been invoiced');
  if (type === 'estimates' && (status === 'approved' || present(record.signatureKey) || present(record.signature))) {
    reasons.push('estimate carries a signed customer approval');
  }
  return reasons;
}

/** Link specs whose key value is present on the record, ready for a lookup. */
export function linkLookups(type, record = {}) {
  const resolve = specs => (specs || [])
    .filter(spec => present(record[spec.key]))
    .map(spec => ({ ...spec, value: String(record[spec.key]) }));
  return { financial: resolve(FINANCIAL_LINKS[type]), blocking: resolve(BLOCKING_LINKS[type]) };
}

function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Decide what removing a record does.
 * `linkCounts` maps `${type}.${field}` → number of linked records found.
 * Returns { action: 'archive' | 'delete' | 'blocked', reasons, message }.
 */
export function deletionPlan(type, record = {}, linkCounts = {}) {
  const lookups = linkLookups(type, record);
  const tally = specs => {
    const byType = new Map();
    for (const spec of specs) {
      const count = Number(linkCounts[`${spec.type}.${spec.field}`] || 0);
      if (count > 0) byType.set(spec.type, Math.max(byType.get(spec.type) || 0, count));
    }
    return [...byType].map(([linkType, count]) => countLabel(count, LINK_LABELS[linkType] || 'record'));
  };
  const financial = [...intrinsicFinancialReasons(type, record), ...tally(lookups.financial).map(item => `linked to ${item}`)];
  const label = TYPE_LABELS[type] || 'record';
  if (financial.length) {
    return {
      action: 'archive',
      reasons: financial,
      message: `This ${label} has financial history, so it will be archived instead of deleted. It stays in reports and can be found under archived records.`,
    };
  }
  const blocking = tally(lookups.blocking);
  if (blocking.length) {
    return {
      action: 'blocked',
      reasons: blocking.map(item => `still has ${item}`),
      message: `Remove this ${label}'s ${blocking.join(', ')} first.`,
    };
  }
  return { action: 'delete', reasons: [], message: `This ${label} has no financial history and will be permanently deleted.` };
}

/** Count linked records from in-memory collections keyed by entity type. */
export function countLinksInCollections(type, record, collections = {}) {
  const { financial, blocking } = linkLookups(type, record);
  const counts = {};
  for (const spec of [...financial, ...blocking]) {
    const rows = Array.isArray(collections[spec.type]) ? collections[spec.type] : [];
    counts[`${spec.type}.${spec.field}`] = rows
      .filter(row => present(row?.[spec.field]) && String(row[spec.field]) === spec.value).length;
  }
  return counts;
}

export function isArchived(record) {
  return present(record?.archivedAt);
}

export function archivedRecord(record, { actor = '', at = new Date().toISOString(), reasons = [] } = {}) {
  return {
    ...record,
    archivedAt: at,
    archivedBy: actor,
    archiveReasons: reasons,
    ...(record && 'active' in record ? { active: false } : {}),
  };
}
