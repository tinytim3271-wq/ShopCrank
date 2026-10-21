/**
 * CSV import for shop records. Pure functions so every import type can be
 * smoke-tested without the browser shell.
 */

import { localIsoDate } from '../shared/dates.js';

export const IMPORT_TYPES = {
  customers: {
    title: 'Customers',
    icon: 'users',
    columns: 'name, phone, email',
    required: 'name',
    sample: 'name,phone,email\nDemo Customer,555-0123,demo.customer@example.com',
  },
  vehicles: {
    title: 'Vehicles',
    icon: 'car-front',
    columns: 'customer, year, make, model, vin, plate',
    required: 'customer, year, make, model',
    sample: 'customer,year,make,model,vin,plate\nDemo Customer,2020,Ford,Escape,DEMOVIN000000010,ABC-1234',
  },
  orders: {
    title: 'Work orders',
    icon: 'clipboard-list',
    columns: 'ro_number, customer, vehicle, complaint, status, total',
    required: 'customer, vehicle, complaint',
    sample: 'ro_number,customer,vehicle,complaint,status,total\nRO-1053,Demo Customer,2020 Ford Escape,Oil change,approved,89.95',
  },
  invoices: {
    title: 'Invoices',
    icon: 'receipt',
    columns: 'number, customer, ro, date, closeout_date, due, status, subtotal, tax_rate, tax, amount',
    required: 'customer, amount',
    sample: 'number,customer,ro,date,closeout_date,due,status,subtotal,tax_rate,tax,amount\nINV-2042,Demo Customer,RO-1053,2026-09-01,2026-09-01,2026-09-15,paid,100.00,8.25,8.25,108.25',
  },
  estimates: {
    title: 'Estimates',
    icon: 'file-spreadsheet',
    columns: 'number, customer, vehicle, summary, status, subtotal, tax, total, email, phone',
    required: 'customer, vehicle, total',
    sample: 'number,customer,vehicle,summary,status,subtotal,tax_rate,tax,total,email,phone\nEST-1001,Demo Customer,2020 Ford Escape,Front brake service,pending,420.00,8.25,34.65,454.65,demo.customer@example.com,555-0123',
  },
  expenses: {
    title: 'Expenses',
    icon: 'wallet-cards',
    columns: 'date, vendor, category, memo, amount',
    required: 'vendor, amount',
    sample: 'date,vendor,category,memo,amount\n2026-08-14,Demo Tool Supply,Tools,Socket set,149.99',
  },
};

const ORDER_STATUSES = ['estimate', 'approved', 'in_progress', 'waiting_parts', 'completed', 'invoiced'];
const INVOICE_STATUSES = ['sent', 'overdue', 'paid'];
const ESTIMATE_STATUSES = ['pending', 'approved', 'declined'];

export function entityLabel(type) {
  if (type === 'orders') return 'work order';
  return String(type || 'record').replace(/s$/, '');
}

export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  const current = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      current.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      current.push(cell.trim());
      if (current.some(Boolean)) rows.push(current.slice());
      current.length = 0;
      cell = '';
    } else {
      cell += char;
    }
  }
  current.push(cell.trim());
  if (current.some(Boolean)) rows.push(current.slice());
  return rows;
}

function rowData(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows.shift().map(header => header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] || ''])));
}

function value(row, ...keys) {
  return keys.map(key => row[key]).find(item => item !== undefined && item !== '') || '';
}

function cleanText(raw, max = 240) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (/^[=@]/.test(text) || /^[+-](?!\d)/.test(text)) text = text.replace(/^[=+@-]+/, '');
  return text.slice(0, max);
}

function moneyAmount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const amount = Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || Math.abs(amount) > 10000000) return Number.NaN;
  return Math.round(amount * 100) / 100;
}

function isoDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text ? '' : text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return '';
  // A date-time is an instant, so read its calendar day in local time. UTC
  // would roll an evening timestamp into the next day.
  return localIsoDate(parsed);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeStatus(raw) {
  return cleanText(raw, 40).toLowerCase().replace(/[\s-]+/g, '_');
}

function orderSerial(id) {
  return Number(String(id || '').split('-')[1]) || 0;
}

function nextOrderId(taken) {
  const max = Math.max(1000, ...[...taken].map(orderSerial));
  let serial = max + 1;
  let id = `RO-${serial}`;
  while (taken.has(id.toLowerCase())) {
    serial += 1;
    id = `RO-${serial}`;
  }
  taken.add(id.toLowerCase());
  return id;
}

function nextPrefixed(prefix, taken, floor) {
  let max = floor;
  for (const value of taken) {
    const match = String(value).match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let serial = max + 1;
  let id = `${prefix}-${serial}`;
  while (taken.has(id.toLowerCase())) {
    serial += 1;
    id = `${prefix}-${serial}`;
  }
  taken.add(id.toLowerCase());
  return id;
}

function emptyResult(type, errors = [], skipped = 0) {
  return { type, records: [], errors, skipped };
}

export function prepareImportRecords(type, text, existing = {}) {
  if (!IMPORT_TYPES[type]) return emptyResult(type, ['Choose a supported import type.']);
  const rows = rowData(text);
  if (!rows.length) return emptyResult(type, ['The file needs a header row and at least one data row.']);

  const customers = existing.customers || [];
  const vehicles = existing.vehicles || [];
  const orders = existing.orders || [];
  const invoices = existing.invoices || [];
  const estimates = existing.estimates || [];
  const taxRateDefault = Number(existing.taxRate);
  const shopTaxRate = Number.isFinite(taxRateDefault) ? taxRateDefault : 0;
  const today = isoDate(existing.today) || localIsoDate();
  const createdAt = existing.createdAt || new Date().toISOString();

  const seenCustomers = new Set(customers.map(item => String(item.name || '').toLowerCase()).filter(Boolean));
  const seenVins = new Set(vehicles.map(item => String(item.vin || '').toLowerCase()).filter(Boolean));
  const seenOrders = new Set(orders.map(item => String(item.id || '').toLowerCase()).filter(Boolean));
  const seenInvoices = new Set(invoices.map(item => String(item.number || item.id || '').toLowerCase()).filter(Boolean));
  const seenEstimates = new Set(estimates.map(item => String(item.number || '').toLowerCase()).filter(Boolean));

  const errors = [];
  const records = [];
  let skipped = 0;

  rows.forEach((row, index) => {
    const line = index + 2;
    const customer = cleanText(value(row, 'customer', 'customer_name', 'name'));
    const amountRaw = value(row, 'amount', 'total');
    const amount = moneyAmount(amountRaw);
    let record = null;
    let error = '';

    if (type === 'customers') {
      const name = cleanText(value(row, 'name', 'customer', 'customer_name'));
      if (!name) error = 'Customer name is required';
      else if (seenCustomers.has(name.toLowerCase())) skipped += 1;
      else {
        seenCustomers.add(name.toLowerCase());
        record = { name, phone: cleanText(value(row, 'phone', 'mobile'), 40), email: cleanText(value(row, 'email'), 120), vehicles: 0, visits: 0, spend: 0 };
      }
    } else if (type === 'vehicles') {
      const year = cleanText(value(row, 'year'), 8);
      const make = cleanText(value(row, 'make'), 40);
      const model = cleanText(value(row, 'model'), 40);
      const vin = cleanText(value(row, 'vin'), 17).toUpperCase();
      if (!customer || !year || !make || !model) error = 'Customer, year, make, and model are required';
      else if (vin && seenVins.has(vin.toLowerCase())) skipped += 1;
      else {
        if (vin) seenVins.add(vin.toLowerCase());
        record = { customer, year, make, model, vin, plate: cleanText(value(row, 'plate', 'license_plate'), 16) };
      }
    } else if (type === 'orders') {
      const providedId = cleanText(value(row, 'ro_number', 'ro', 'work_order'), 40);
      const vehicle = cleanText(value(row, 'vehicle', 'vehicle_description'), 120);
      const complaint = cleanText(value(row, 'complaint', 'description', 'concern'), 500);
      const status = normalizeStatus(value(row, 'status')) || 'estimate';
      if (!customer || !vehicle || !complaint) error = 'Customer, vehicle, and complaint are required';
      else if (providedId && seenOrders.has(providedId.toLowerCase())) skipped += 1;
      else if (amountRaw && !Number.isFinite(amount)) error = 'Total must be a number';
      else {
        const id = providedId || nextOrderId(seenOrders);
        if (providedId) seenOrders.add(id.toLowerCase());
        record = {
          id,
          customer,
          phone: cleanText(value(row, 'phone'), 40),
          vehicle,
          vin: cleanText(value(row, 'vin'), 17).toUpperCase() || 'VIN pending',
          complaint,
          status: ORDER_STATUSES.includes(status) ? status : 'estimate',
          priority: 'normal',
          tech: cleanText(value(row, 'tech', 'technician'), 80) || 'Unassigned',
          bay: cleanText(value(row, 'bay'), 40) || 'Unassigned',
          mobile: value(row, 'mobile').toLowerCase() === 'true',
          promise: cleanText(value(row, 'promise'), 40) || 'Unscheduled',
          total: Number.isFinite(amount) ? amount : 0,
          scheduled: cleanText(value(row, 'scheduled'), 40) || 'Unscheduled',
          notes: cleanText(value(row, 'notes'), 500),
          labor: 0,
          parts: 0,
          tax: 0,
        };
      }
    } else if (type === 'invoices') {
      const providedNumber = cleanText(value(row, 'number', 'invoice', 'invoice_number'), 40).toUpperCase();
      const status = normalizeStatus(value(row, 'status')) || 'sent';
      const date = isoDate(value(row, 'date', 'issued', 'invoice_date')) || today;
      const closeoutRaw = value(
        row,
        'closeout_date',
        'closeout',
        'closed_date',
        'closed_at',
        'paid_date',
        'paid_at',
        'completed_date',
        'completed_at',
      );
      // Historical imports need a stable reporting date. Prefer an explicit
      // lifecycle date; when the source has none, use the invoice date.
      const closedAt = isoDate(closeoutRaw) || (closeoutRaw ? '' : date);
      const dueRaw = value(row, 'due', 'due_date');
      const due = isoDate(dueRaw) || (dueRaw ? '' : addDays(date, 14));
      const rateRaw = value(row, 'tax_rate', 'taxrate');
      const taxRate = rateRaw === '' ? shopTaxRate : Number(rateRaw);
      const subtotal = moneyAmount(value(row, 'subtotal'));
      const tax = moneyAmount(value(row, 'tax'));
      if (!customer) error = 'Customer is required';
      else if (!Number.isFinite(amount) || amount < 0) error = 'A numeric invoice amount is required';
      else if (rateRaw !== '' && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)) error = 'Tax rate must be between 0 and 100';
      else if (closeoutRaw && !closedAt) error = 'Closeout date must be a real date';
      else if (dueRaw && !due) error = 'Due date must be a real date';
      else if (!INVOICE_STATUSES.includes(status)) error = 'Status must be sent, overdue, or paid';
      else if (providedNumber && seenInvoices.has(providedNumber.toLowerCase())) skipped += 1;
      else {
        const number = providedNumber || nextPrefixed('INV', seenInvoices, 2000);
        if (providedNumber) seenInvoices.add(number.toLowerCase());
        const resolvedTax = Number.isFinite(tax) ? tax : (Number.isFinite(subtotal) ? Math.round(subtotal * taxRate) / 100 : Math.round((amount - (amount / (1 + (taxRate / 100) || 1))) * 100) / 100);
        const resolvedSubtotal = Number.isFinite(subtotal) ? subtotal : Math.round((amount - (Number.isFinite(resolvedTax) ? resolvedTax : 0)) * 100) / 100;
        record = {
          id: number,
          number,
          ro: cleanText(value(row, 'ro', 'ro_number', 'work_order'), 40),
          customer,
          vehicle: cleanText(value(row, 'vehicle'), 120),
          amount,
          subtotal: resolvedSubtotal,
          tax: Number.isFinite(resolvedTax) ? resolvedTax : 0,
          taxRate,
          status,
          date,
          closedAt,
          closeoutSource: closeoutRaw ? 'source_closeout_date' : 'invoice_date',
          due,
          lines: [],
          importSource: 'csv',
          createdAt,
        };
      }
    } else if (type === 'estimates') {
      const providedNumber = cleanText(value(row, 'number', 'estimate', 'estimate_number'), 40).toUpperCase();
      const vehicle = cleanText(value(row, 'vehicle', 'vehicle_description'), 120);
      const summary = cleanText(value(row, 'summary', 'complaint', 'description', 'concern'), 500);
      const status = normalizeStatus(value(row, 'status')) || 'pending';
      const rateRaw = value(row, 'tax_rate', 'taxrate');
      const taxRate = rateRaw === '' ? shopTaxRate : Number(rateRaw);
      const subtotal = moneyAmount(value(row, 'subtotal'));
      const tax = moneyAmount(value(row, 'tax'));
      if (!customer || !vehicle) error = 'Customer and vehicle are required';
      else if (!Number.isFinite(amount) || amount < 0) error = 'A numeric estimate total is required';
      else if (rateRaw !== '' && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)) error = 'Tax rate must be between 0 and 100';
      else if (!ESTIMATE_STATUSES.includes(status)) error = 'Status must be pending, approved, or declined';
      else if (providedNumber && seenEstimates.has(providedNumber.toLowerCase())) skipped += 1;
      else {
        const number = providedNumber || nextPrefixed('EST', seenEstimates, 1000);
        if (providedNumber) seenEstimates.add(number.toLowerCase());
        const resolvedSubtotal = Number.isFinite(subtotal) ? subtotal : amount;
        const resolvedTax = Number.isFinite(tax) ? tax : Math.max(0, Math.round((amount - resolvedSubtotal) * 100) / 100);
        record = {
          id: `estimate-${number}`,
          number,
          customer,
          email: cleanText(value(row, 'email'), 120),
          phone: cleanText(value(row, 'phone'), 40),
          vehicle,
          workOrderId: cleanText(value(row, 'ro', 'ro_number', 'work_order'), 40) || null,
          createdAt,
          status,
          lines: [{ service: summary || 'Imported service', notes: summary, hours: 0, laborRate: 0, labor: 0, parts: resolvedSubtotal, total: resolvedSubtotal }],
          fees: 0,
          subtotal: resolvedSubtotal,
          tax: resolvedTax,
          taxRate,
          total: amount,
          summary,
          signature: null,
          authorizationName: '',
        };
      }
    } else if (type === 'expenses') {
      const vendor = cleanText(value(row, 'vendor', 'payee'), 120);
      const expenseAmount = moneyAmount(value(row, 'amount', 'total'));
      const date = isoDate(value(row, 'date')) || today;
      if (!vendor || !Number.isFinite(expenseAmount)) error = 'Vendor and numeric amount are required';
      else {
        record = {
          date: value(row, 'date') ? date : today,
          vendor,
          category: cleanText(value(row, 'category'), 80) || 'Uncategorized',
          memo: cleanText(value(row, 'memo', 'description', 'notes'), 240),
          amount: expenseAmount,
        };
      }
    }

    if (error) {
      errors.push(`Row ${line}: ${error}`);
      skipped += 1;
    } else if (record) {
      records.push(record);
    }
  });

  return { type, records, errors, skipped };
}
