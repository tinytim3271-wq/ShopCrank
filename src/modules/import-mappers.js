/**
 * Free migration from other shop systems: convert Tekmetric, Shopmonkey,
 * AutoLeap, Shop-Ware, and Mitchell 1 CSV exports into ShopCrank's import
 * columns, so the existing validated import (prepareImportRecords) handles
 * duplicates, money, dates, and the preview unchanged.
 *
 * Column names differ by export and version, so each system lists the
 * headers its exports use; unknown columns are ignored, and the import
 * preview shows exactly what will be created before anything is saved.
 */

import { parseCsv } from './imports.js';

export function normalizeHeader(header) {
  return String(header || '').toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Aliases shared by every system; system entries add their own first.
const COMMON = Object.freeze({
  first_name: ['first_name', 'firstname', 'customer_first_name', 'customer_first', 'first'],
  last_name: ['last_name', 'lastname', 'customer_last_name', 'customer_last', 'last'],
  name: ['customer_name', 'name', 'customer', 'full_name', 'company_name', 'owner', 'owner_name', 'customer_full_name'],
  phone: ['phone', 'phone_number', 'primary_phone', 'mobile', 'mobile_phone', 'cell_phone', 'cell', 'phone_1', 'home_phone', 'work_phone'],
  email: ['email', 'email_address', 'e_mail', 'primary_email'],
  year: ['year', 'vehicle_year', 'model_year'],
  make: ['make', 'vehicle_make'],
  model: ['model', 'vehicle_model'],
  vin: ['vin', 'vehicle_vin', 'vin_number'],
  plate: ['plate', 'license_plate', 'license', 'lic_plate', 'license_plate_number', 'tag'],
  vehicle: ['vehicle', 'vehicle_description', 'vehicle_name', 'year_make_model'],
  ro_number: ['ro_number', 'repair_order_number', 'repair_order', 'ro', 'order_number', 'work_order_number', 'work_order'],
  invoice_number: ['invoice_number', 'invoice', 'invoice_id'],
  complaint: ['complaint', 'concern', 'concerns', 'customer_concern', 'description', 'work_requested', 'reason_for_visit', 'notes'],
  status: ['status', 'ro_status', 'order_status', 'workflow_status', 'stage'],
  total: ['total', 'grand_total', 'total_sale', 'invoice_total', 'ro_total', 'amount', 'total_amount'],
  subtotal: ['subtotal', 'sub_total', 'total_before_tax', 'pre_tax_total'],
  tax: ['tax', 'sales_tax', 'tax_total', 'total_tax'],
  date: ['invoice_date', 'posted_date', 'date_posted', 'date', 'created_date', 'created_at', 'date_created', 'completed_date'],
  closeout_date: ['paid_date', 'payment_date', 'date_paid', 'closed_date', 'closeout_date', 'date_closed'],
  mileage: ['mileage', 'odometer', 'miles_in', 'mileage_in'],
  balance: ['balance', 'balance_due', 'amount_due', 'outstanding', 'open_balance', 'remaining_balance'],
  payment_status: ['payment_status', 'paid_status', 'paid'],
});

const PAID_WORDS = new Set(['paid', 'paid_in_full', 'closed_paid', 'yes', 'true']);
const ESTIMATE_DECISIONS = Object.freeze({ approved: 'approved', accepted: 'approved', authorized: 'approved', declined: 'declined', rejected: 'declined' });

export const SOURCE_SYSTEMS = Object.freeze({
  tekmetric: {
    name: 'Tekmetric',
    aliases: { ro_number: ['ro_number', 'repair_order_number'], date: ['posted_date', 'completed_date'], complaint: ['concerns'] },
    statuses: { estimate: 'estimate', work_in_progress: 'in_progress', complete: 'completed', posted: 'invoiced', accounts_receivable: 'invoiced', saved_for_later: 'estimate' },
    signature: ['repair_order_number', 'posted_date'],
  },
  shopmonkey: {
    name: 'Shopmonkey',
    aliases: { ro_number: ['order_number', 'order'], complaint: ['complaint', 'order_name'] },
    statuses: { estimate: 'estimate', work_in_progress: 'in_progress', in_progress: 'in_progress', invoice: 'completed', paid: 'invoiced', completed: 'completed' },
    signature: ['order_number', 'order_name'],
  },
  autoleap: {
    name: 'AutoLeap',
    aliases: { name: ['customer_name'], ro_number: ['ro_number', 'ro'], total: ['invoice_total', 'total'] },
    statuses: { estimate: 'estimate', in_progress: 'in_progress', work_in_progress: 'in_progress', completed: 'completed', invoiced: 'invoiced', paid: 'invoiced' },
    signature: ['ro_number', 'invoice_total'],
  },
  shopware: {
    name: 'Shop-Ware',
    aliases: { first_name: ['customer_first'], last_name: ['customer_last'], ro_number: ['ro_number', 'repair_order'] },
    statuses: { estimate: 'estimate', wip: 'in_progress', work_in_progress: 'in_progress', complete: 'completed', invoiced: 'invoiced', closed: 'invoiced' },
    signature: ['customer_first', 'customer_last'],
  },
  mitchell1: {
    name: 'Mitchell 1 Manager SE',
    aliases: { ro_number: ['ro_number', 'repair_order_number'], invoice_number: ['invoice_number'], total: ['total_sale', 'invoice_total', 'total'], phone: ['cell_phone', 'home_phone', 'work_phone', 'phone'], email: ['e_mail', 'email'], plate: ['lic_plate', 'license'] },
    statuses: { estimate: 'estimate', open: 'in_progress', work_order: 'in_progress', finalized: 'invoiced', invoice: 'invoiced', closed: 'invoiced' },
    signature: ['total_sale', 'lic_plate'],
  },
});

export const SOURCE_OPTIONS = Object.freeze([['shopcrank', 'ShopCrank template'], ...Object.entries(SOURCE_SYSTEMS).map(([id, system]) => [id, system.name])]);

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function aliasesFor(system, field) {
  return [...new Set([...(system?.aliases?.[field] || []), ...(COMMON[field] || [])])];
}

/** "Smith, John" (Mitchell 1 style) → "John Smith". */
function displayName(row, system) {
  const first = pick(row, aliasesFor(system, 'first_name'));
  const last = pick(row, aliasesFor(system, 'last_name'));
  if (first || last) return [first, last].filter(Boolean).join(' ');
  const name = pick(row, aliasesFor(system, 'name'));
  const reversed = /^([^,]+),\s*(.+)$/.exec(name);
  return reversed ? `${reversed[2]} ${reversed[1]}` : name;
}

function mapStatus(system, raw) {
  const key = normalizeHeader(raw);
  return system?.statuses?.[key] || key;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\n');
}

/** Pick the most likely source system from a file's headers (null when unsure). */
export function detectSourceSystem(text) {
  const [headerRow = []] = parseCsv(text);
  const headers = new Set(headerRow.map(normalizeHeader));
  let best = null;
  for (const [id, system] of Object.entries(SOURCE_SYSTEMS)) {
    const hits = system.signature.filter(header => headers.has(header)).length;
    if (hits === system.signature.length && (!best || hits > best.hits)) best = { id, hits };
  }
  return best?.id || null;
}

const CANONICAL = Object.freeze({
  customers: ['name', 'phone', 'email'],
  vehicles: ['customer', 'year', 'make', 'model', 'vin', 'plate'],
  orders: ['ro_number', 'customer', 'vehicle', 'vin', 'complaint', 'status', 'total', 'phone'],
  invoices: ['number', 'customer', 'ro', 'date', 'closeout_date', 'status', 'subtotal', 'tax', 'amount'],
  estimates: ['number', 'customer', 'vehicle', 'summary', 'status', 'subtotal', 'tax', 'total', 'email', 'phone'],
});

/**
 * Convert a source-system export into the ShopCrank CSV columns for `type`.
 * Returns { csv, rows, system } so callers can show what was recognized.
 */
export function mapExportToCanonicalCsv(sourceId, type, text) {
  const system = SOURCE_SYSTEMS[sourceId];
  const parsed = parseCsv(text);
  if (!system || !CANONICAL[type] || parsed.length < 2) return { csv: String(text || ''), rows: Math.max(0, parsed.length - 1), system: null, rejected: [] };
  const headers = parsed.shift().map(normalizeHeader);
  const rows = parsed.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
  const get = (row, field) => pick(row, aliasesFor(system, field));
  const vehicleText = row => get(row, 'vehicle') || [get(row, 'year'), get(row, 'make'), get(row, 'model')].filter(Boolean).join(' ');
  const statusFor = row => mapStatus(system, get(row, 'status'));
  const rejected = [];
  const mapped = rows.map(row => {
    const customer = displayName(row, system);
    if (type === 'customers') return { name: customer, phone: get(row, 'phone'), email: get(row, 'email') };
    if (type === 'vehicles') return { customer, year: get(row, 'year'), make: get(row, 'make'), model: get(row, 'model'), vin: get(row, 'vin'), plate: get(row, 'plate') };
    if (type === 'orders') {
      const status = statusFor(row);
      return { ro_number: get(row, 'ro_number'), customer, vehicle: vehicleText(row), vin: get(row, 'vin'), complaint: get(row, 'complaint') || `Imported from ${system.name}`, status: status === 'invoiced' ? 'invoiced' : status, total: get(row, 'total'), phone: get(row, 'phone') };
    }
    if (type === 'invoices') {
      // Completed or posted work isn't proof of payment (Tekmetric 'Accounts Receivable'
      // is posted and unpaid); only a paid status or a zero balance marks an invoice paid.
      const raw = normalizeHeader(get(row, 'status'));
      const balance = Number(String(get(row, 'balance')).replace(/[$,\s]/g, ''));
      const paid = PAID_WORDS.has(raw) || PAID_WORDS.has(normalizeHeader(get(row, 'payment_status'))) || (get(row, 'balance') !== '' && balance === 0);
      const total = Number(String(get(row, 'total')).replace(/[$,\s]/g, ''));
      if (get(row, 'balance') !== '' && balance > 0 && Number.isFinite(total) && balance < total) {
        rejected.push(`${get(row, 'invoice_number') || get(row, 'ro_number') || 'Invoice'} is partly paid (${get(row, 'balance')} of ${get(row, 'total')} open); import it after recording its payment, or enter it by hand.`);
        return null;
      }
      return { number: get(row, 'invoice_number') || get(row, 'ro_number'), customer, ro: get(row, 'ro_number'), date: get(row, 'date'), closeout_date: paid ? get(row, 'closeout_date') : '', status: paid ? 'paid' : 'sent', subtotal: get(row, 'subtotal'), tax: get(row, 'tax'), amount: get(row, 'total') };
    }
    const decision = ESTIMATE_DECISIONS[normalizeHeader(get(row, 'status'))] || 'pending';
    return { number: get(row, 'ro_number'), customer, vehicle: vehicleText(row), summary: get(row, 'complaint'), status: decision, subtotal: get(row, 'subtotal'), tax: get(row, 'tax'), total: get(row, 'total'), email: get(row, 'email'), phone: get(row, 'phone') };
  });
  const kept = mapped.filter(Boolean);
  return { csv: toCsv(CANONICAL[type], kept), rows: kept.length, system: system.name, rejected };
}
