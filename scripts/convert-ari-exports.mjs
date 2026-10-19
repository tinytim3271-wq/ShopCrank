#!/usr/bin/env node
/**
 * Convert ARI (Auto Repair Software) CSV exports into ShopCrank import CSVs.
 *
 * Usage:
 *   node scripts/convert-ari-exports.mjs
 *   node scripts/convert-ari-exports.mjs --clients path.csv --vehicles path.csv --out dir
 *
 * Defaults look in common Reliable Automotive / Downloads / Desktop locations.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_SEARCH = [
  join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop'),
  join(process.env.USERPROFILE || '', 'OneDrive', 'Reliable Automotive Services', 'ari'),
  join(process.env.USERPROFILE || '', 'Downloads'),
  join(process.env.USERPROFILE || '', 'OneDrive', 'downloads', 'aari'),
];

function parseArgs(argv) {
  const out = { clients: '', vehicles: '', orders: '', invoices: '', estimates: '', outDir: '' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--clients') out.clients = val;
    else if (key === '--vehicles') out.vehicles = val;
    else if (key === '--orders' || key === '--work-orders') out.orders = val;
    else if (key === '--invoices') out.invoices = val;
    else if (key === '--estimates') out.estimates = val;
    else if (key === '--out') out.outDir = val;
    else continue;
    i++;
  }
  return out;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n') + '\n';
}

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\ufeff/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map(normalizeHeader);
  return rows.map((cells) => Object.fromEntries(headers.map((key, index) => [key, cells[index] || ''])));
}

async function readCsvFile(path) {
  const chunks = [];
  for await (const line of createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    chunks.push(line);
  }
  return parseCsvText(chunks.join('\n'));
}

function pick(row, ...keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function findLatestMtime(patterns, dirs = DEFAULT_SEARCH) {
  const matches = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.csv')) continue;
      if (patterns.some((re) => re.test(lower))) {
        const full = join(dir, name);
        matches.push({ full, mtime: statSync(full).mtimeMs });
      }
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.full || '';
}

function formatAddress(row) {
  const line1 = pick(row, 'address', 'bill_address');
  const city = pick(row, 'city');
  const state = pick(row, 'state');
  const zip = pick(row, 'zip');
  const cityLine = [city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '');
  return [line1, cityLine.trim()].filter(Boolean).join(', ');
}

function vehicleLabel(row) {
  const year = pick(row, 'year');
  const make = pick(row, 'make');
  const model = pick(row, 'model');
  const fromParts = [year, make, model].filter(Boolean).join(' ');
  if (fromParts) return fromParts;
  const raw = pick(row, 'vehicle');
  return raw.replaceAll('|', ' ').replace(/\s+/g, ' ').trim();
}

function mapOrderStatus(jobStatus, invStatus, kind = 'order') {
  const job = String(jobStatus || '').toLowerCase();
  const inv = String(invStatus || '').toLowerCase();
  if (kind === 'estimate' || inv === 'sent' || job === 'estimate') return 'estimate';
  if (inv === 'paid' || job === 'completed' || job === 'invoiced') return 'completed';
  if (job.includes('progress') || job === 'open') return 'in_progress';
  if (job.includes('part')) return 'waiting_parts';
  if (inv === 'unpaid' || inv === 'partial') return 'invoiced';
  return 'estimate';
}

function resolvePaths(args) {
  return {
    clients:
      args.clients
      || findLatestMtime([/clientsreport/, /^clients\.csv$/, /ari customer data\.csv$/, /^import\.csv$/]),
    vehicles:
      args.vehicles
      || findLatestMtime([/vehiclesreport/, /^vehicles\.csv$/]),
    orders:
      args.orders
      || findLatestMtime([/work orders/, /job cards/]),
    invoices:
      args.invoices
      || findLatestMtime([/ari invoices/, /^invoices\.csv$/]),
    estimates:
      args.estimates
      || findLatestMtime([/ari estimates/, /^estimates\.csv$/]),
    outDir:
      args.outDir
      || join(process.env.USERPROFILE || ROOT, 'OneDrive', 'Reliable Automotive Services', 'ari', 'shopcrank-import'),
  };
}

async function main() {
  const paths = resolvePaths(parseArgs(process.argv));
  mkdirSync(paths.outDir, { recursive: true });

  console.log('ARI → ShopCrank converter');
  console.log('clients:   ', paths.clients || '(missing)');
  console.log('vehicles:  ', paths.vehicles || '(missing)');
  console.log('orders:    ', paths.orders || '(missing)');
  console.log('invoices:  ', paths.invoices || '(missing)');
  console.log('estimates: ', paths.estimates || '(missing)');
  console.log('output:    ', paths.outDir);

  if (!paths.clients) {
    console.error('No ARI clients CSV found. Pass --clients path.csv');
    process.exit(1);
  }

  const clients = await readCsvFile(paths.clients);
  const byId = new Map();
  const customerRows = [];
  const seenNames = new Set();

  for (const row of clients) {
    const id = pick(row, 'record_id', 'id', 'record_id_');
    const name = pick(row, 'name', 'customer', 'customer_name', 'bill_name');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    if (id) byId.set(id, name);
    customerRows.push({
      name,
      phone: pick(row, 'phone', 'mobile'),
      email: pick(row, 'email'),
      address: formatAddress(row),
      notes: pick(row, 'notes', 'company', 'source', 'labels'),
      ari_id: id,
    });
  }

  writeFileSync(
    join(paths.outDir, 'shopcrank-customers.csv'),
    toCsv(['name', 'phone', 'email', 'address', 'notes', 'ari_id'], customerRows),
  );

  let vehicleRows = [];
  let vehiclesSkipped = 0;
  if (paths.vehicles) {
    const vehicles = await readCsvFile(paths.vehicles);
    for (const row of vehicles) {
      const ownerId = pick(row, 'owner_id', 'ownerid', 'client_id', 'customer_id');
      const customer = byId.get(ownerId) || pick(row, 'customer', 'name', 'owner');
      const year = pick(row, 'year');
      const make = pick(row, 'make');
      const model = pick(row, 'model');
      if (!customer || !year || !make || !model) {
        vehiclesSkipped++;
        continue;
      }
      vehicleRows.push({
        customer,
        year,
        make,
        model,
        vin: pick(row, 'vin'),
        plate: pick(row, 'reg_num', 'regnum', 'plate', 'license_plate'),
        mileage: pick(row, 'mileage', 'milage'),
        color: pick(row, 'color'),
        ari_id: pick(row, 'record_id', 'id'),
      });
    }
    writeFileSync(
      join(paths.outDir, 'shopcrank-vehicles.csv'),
      toCsv(['customer', 'year', 'make', 'model', 'vin', 'plate', 'mileage', 'color', 'ari_id'], vehicleRows),
    );
  }

  const orderRows = [];
  const pushOrder = (row, kind) => {
    const customer = pick(row, 'name', 'customer', 'customer_name');
    const vehicle = vehicleLabel(row);
    if (!customer || !vehicle) return;
    const idRaw = pick(row, 'id', 'ro_number', 'ro', 'work_order');
    const ro = idRaw ? (String(idRaw).toUpperCase().startsWith('RO-') ? idRaw : `RO-${idRaw}`) : '';
    const status = mapOrderStatus(pick(row, 'job_status', 'status'), pick(row, 'inv_status', 'invoice_status', 'status'), kind);
    const total = pick(row, 'total', 'amount', 'paidamount').replace(/[$,]/g, '') || '0';
    orderRows.push({
      ro_number: ro,
      customer,
      vehicle,
      complaint: kind === 'estimate' ? 'Imported ARI estimate' : 'Imported from ARI',
      status,
      total,
      notes: `ARI ${kind}; balance ${pick(row, 'balancedue', 'balance_due') || '0'}; paid ${pick(row, 'paidamount', 'paid_amount') || '0'}`,
      promise: pick(row, 'date', 'invoice_date', 'paid_date') || '',
    });
  };

  if (paths.orders) {
    for (const row of await readCsvFile(paths.orders)) pushOrder(row, 'work order');
  }
  if (paths.invoices) {
    for (const row of await readCsvFile(paths.invoices)) pushOrder(row, 'invoice');
  }
  if (paths.estimates) {
    for (const row of await readCsvFile(paths.estimates)) pushOrder(row, 'estimate');
  }

  // Deduplicate by RO number / customer+vehicle+total
  const seenOrders = new Set();
  const uniqueOrders = [];
  for (const row of orderRows) {
    const key = row.ro_number || `${row.customer}|${row.vehicle}|${row.total}|${row.status}`;
    if (seenOrders.has(key)) continue;
    seenOrders.add(key);
    uniqueOrders.push(row);
  }
  if (uniqueOrders.length) {
    writeFileSync(
      join(paths.outDir, 'shopcrank-orders.csv'),
      toCsv(['ro_number', 'customer', 'vehicle', 'complaint', 'status', 'total', 'notes', 'promise'], uniqueOrders),
    );
  }

  const summary = {
    customers: customerRows.length,
    vehicles: vehicleRows.length,
    vehiclesSkipped,
    orders: uniqueOrders.length,
    outDir: paths.outDir,
    files: readdirSync(paths.outDir).filter((name) => name.startsWith('shopcrank-')),
  };
  writeFileSync(join(paths.outDir, 'import-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nIn ShopCrank: Imports → upload customers, then vehicles, then work orders.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
