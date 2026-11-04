/**
 * Archived-records UI helpers, kept out of src/runtime/legacy.js so they can be
 * tested on their own (first step of splitting the settings code out of legacy.js).
 */
export const ARCHIVE_NOTE = 'Records with payments, signatures or a sent invoice are archived for your tax records and can be restored from Settings → Archived records. Everything else is permanently deleted.';

export const ARCHIVE_TYPE_LABELS = Object.freeze({ customers: 'Customers', vehicles: 'Vehicles', orders: 'Work orders', invoices: 'Invoices', payments: 'Payments' });

/** One-line label for an archived record in the Settings list. */
export function archivedRecordLabel(type, item = {}, money = value => `$${Number(value || 0).toFixed(2)}`) {
  if (type === 'customers') return item.name || item.id;
  if (type === 'vehicles') return [item.year, item.make, item.model].filter(Boolean).join(' ') || item.vin || item.id;
  if (type === 'invoices') return `${item.number || item.id}${item.customer ? ` · ${item.customer}` : ''}${item.amount != null ? ` · ${money(Number(item.amount || 0))}` : ''}`;
  if (type === 'payments') return `${money(Number(item.amount || 0))}${item.invoiceNumber ? ` · ${item.invoiceNumber}` : ''}${item.customer ? ` · ${item.customer}` : ''}`;
  return `${item.id}${item.customer ? ` · ${item.customer}` : ''}`;
}

/**
 * Apply a DELETE response to in-memory collections. The Worker answers 204 for a
 * permanent delete and `{ action: 'archive', archived, deleted }` for an archive;
 * archived and deleted records both leave the everyday lists. Returns true for an archive.
 */
/** Types kept in memory once archived, so accounting and tax views still count them. */
export const KEPT_WHEN_ARCHIVED = Object.freeze(new Set(['invoices', 'payments']));

const matches = (ids, item) => ids.has(String(item?.id ?? '')) || (item?.number != null && ids.has(String(item.number)));

export function applyRemovalResult(collections, result, at = new Date().toISOString()) {
  if (!result || result.action !== 'archive') return false;
  for (const [type, list] of Object.entries(result.archived || {})) {
    if (!Array.isArray(collections[type])) continue;
    const ids = new Set((list || []).map(String));
    collections[type] = KEPT_WHEN_ARCHIVED.has(type)
      ? collections[type].map(item => (matches(ids, item) ? { ...item, archivedAt: item.archivedAt || at, archiveReason: result.reason || item.archiveReason } : item))
      : collections[type].filter(item => !matches(ids, item));
  }
  for (const [type, list] of Object.entries(result.deleted || {})) {
    if (!Array.isArray(collections[type])) continue;
    const ids = new Set((list || []).map(String));
    collections[type] = collections[type].filter(item => !matches(ids, item));
  }
  return true;
}

/** Everyday lists (Invoices, Payments) leave archived records out. */
export function withoutArchived(rows = []) {
  return rows.filter(item => !(item && String(item.archivedAt || '').trim()));
}
