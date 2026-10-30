/**
 * Bulk payment import for invoices brought over from another shop system.
 *
 * The flow is preview -> (optional dry run) -> commit. Every mode runs the same
 * validation; only a non-dry-run commit writes, and it writes every payment,
 * invoice balance, linked work order and the audit entry in one D1 batch, so
 * the import is all or nothing.
 */
import { HttpError } from './http.mjs';
import { parseCsv } from '../../src/modules/imports.js';
import { entityWriteStatement, paymentStatus } from './payments.mjs';

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 512 * 1024;

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const COLUMN_ALIASES = {
  invoice: ['invoice_number', 'invoice', 'invoice_no', 'invoice_num', 'invoice_id', 'inv', 'inv_number', 'inv_no', 'number'],
  amount: ['amount', 'payment_amount', 'amount_paid', 'paid_amount', 'payment', 'total_paid'],
  date: ['date_received', 'date', 'received', 'received_date', 'received_at', 'payment_date', 'paid_date', 'date_paid'],
  method: ['payment_method', 'method', 'payment_type', 'tender', 'tender_type', 'type'],
  reference: ['reference', 'ref', 'reference_number', 'ref_number', 'check_number', 'check_no', 'transaction_id', 'confirmation', 'confirmation_number', 'auth_code'],
  note: ['note', 'notes', 'memo', 'comment', 'comments', 'description'],
};
const REQUIRED_COLUMNS = ['invoice', 'amount', 'date', 'method'];
const COLUMN_LABELS = { invoice: 'invoice number', amount: 'amount', date: 'date received', method: 'payment method' };

const METHOD_ALIASES = {
  cash: 'cash',
  check: 'check', cheque: 'check', chk: 'check',
  card: 'card', credit: 'card', credit_card: 'card', debit: 'card', debit_card: 'card', visa: 'card',
  mastercard: 'card', mc: 'card', amex: 'card', american_express: 'card', discover: 'card',
  bank: 'bank', ach: 'bank', wire: 'bank', bank_transfer: 'bank', transfer: 'bank', eft: 'bank', zelle: 'bank',
  processor: 'processor', stripe: 'processor', square: 'processor',
  other: 'other',
};

const headerKey = header => String(header || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const lookupKey = value => String(value ?? '').trim().toUpperCase();

function cleanText(raw, max) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  // Same spreadsheet-formula guard as the record importer.
  if (/^[=@]/.test(text) || /^[+-](?!\d)/.test(text)) text = text.replace(/^[=+@-]+/, '');
  return text.slice(0, max);
}

function parseAmount(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || text.includes('-');
  const amount = Number(text.replace(/[$,\s()-]/g, ''));
  if (!Number.isFinite(amount)) return Number.NaN;
  return roundMoney(negative ? -amount : amount);
}

/** Accepts 2026-10-05, 10/5/2026, 10/5/26 and full ISO timestamps; returns YYYY-MM-DD or ''. */
export function parsePaymentDate(raw) {
  const text = String(raw || '').trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (match) [, year, month, day] = match.map(Number);
  else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    [, month, day, year] = match.map(Number);
    if (year < 100) year += 2000;
  } else return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return date.toISOString().slice(0, 10);
}

function customerName(record) {
  const customer = record?.customer;
  return String((customer && typeof customer === 'object' ? customer.name : customer) || '');
}

/** Parse the uploaded CSV into raw rows keyed by canonical column. Throws on a bad header. */
export function readPaymentCsv(text) {
  const source = String(text || '');
  if (!source.trim()) throw new HttpError(400, 'The CSV file is empty');
  if (source.length > MAX_IMPORT_BYTES) throw new HttpError(413, 'The CSV file is larger than 512 KB; split it into smaller files');
  const rows = parseCsv(source);
  if (rows.length < 2) throw new HttpError(400, 'The CSV file has a header but no payment rows');
  const headers = rows.shift().map(headerKey);
  const columns = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = aliases.map(alias => headers.indexOf(alias)).find(position => position >= 0);
    if (index !== undefined) columns[field] = index;
  }
  const missing = REQUIRED_COLUMNS.filter(field => columns[field] === undefined);
  if (missing.length) {
    throw new HttpError(400, `The CSV is missing required column${missing.length === 1 ? '' : 's'}: ${missing.map(field => COLUMN_LABELS[field]).join(', ')}`);
  }
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, `Import at most ${MAX_IMPORT_ROWS} payments per file`);
  return rows.map((cells, index) => ({
    // Spreadsheet line number: the header is line 1.
    line: index + 2,
    ...Object.fromEntries(Object.entries(columns).map(([field, position]) => [field, cells[position] ?? ''])),
  }));
}

/**
 * Validate parsed rows against the shop's invoices and recorded payments.
 * Pure: `invoices` are { record, row } entity rows, `payments` are completed
 * payment records already on file for those invoices.
 */
export function validatePaymentRows(rows, { invoices = [], payments = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  const byKey = new Map();
  for (const invoice of invoices) {
    for (const key of new Set([lookupKey(invoice.record.number), lookupKey(invoice.record.id)])) {
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) || []), invoice]);
    }
  }
  const ledger = new Map();
  const ledgerFor = (invoice) => {
    const id = invoice.record.id;
    if (ledger.has(id)) return ledger.get(id);
    const number = invoice.record.number || id;
    const prior = payments.filter(payment => payment.status === 'completed' && (
      payment.invoiceNumber === number || (invoice.record.ro && payment.workOrderId === invoice.record.ro)
    ));
    const recorded = roundMoney(prior.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    // Same rule as chargeTargetSnapshot: an invoice imported as paid with no
    // payment records counts as paid. Here that is exactly the gap being
    // filled, so its balance opens at the full total.
    const legacyPaid = invoice.record.status === 'paid' && recorded === 0 && invoice.record.paymentStatus == null;
    const entry = {
      invoice,
      total: roundMoney(invoice.record.amount),
      paid: recorded,
      legacyPaid,
      references: new Map(prior.filter(payment => payment.reference).map(payment => [lookupKey(payment.reference), 'on file'])),
      prior,
      batch: [],
    };
    ledger.set(id, entry);
    return entry;
  };

  const valid = [];
  const skipped = [];
  const skip = (row, reason) => skipped.push({ line: row.line, invoiceNumber: cleanText(row.invoice, 60), reason });

  for (const row of rows) {
    const key = lookupKey(row.invoice);
    if (!key) { skip(row, 'Invoice number is blank'); continue; }
    const matches = byKey.get(key) || [];
    const exact = matches.filter(match => lookupKey(match.record.number) === key);
    const candidates = exact.length ? exact : matches;
    if (!candidates.length) { skip(row, 'No invoice with this number'); continue; }
    if (candidates.length > 1) { skip(row, `${candidates.length} invoices share this number; record this payment by hand`); continue; }
    const amount = parseAmount(row.amount);
    if (amount === null) { skip(row, 'Amount is blank'); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { skip(row, `Amount "${cleanText(row.amount, 30)}" must be a number greater than zero`); continue; }
    if (amount > 10_000_000) { skip(row, 'Amount is too large'); continue; }
    const date = parsePaymentDate(row.date);
    if (!date) { skip(row, `Date "${cleanText(row.date, 30)}" is not a valid date (use YYYY-MM-DD or MM/DD/YYYY)`); continue; }
    if (date > today) { skip(row, `Date ${date} is in the future`); continue; }
    const rawMethod = cleanText(row.method, 40);
    if (!rawMethod) { skip(row, 'Payment method is blank'); continue; }
    const warnings = [];
    let method = METHOD_ALIASES[headerKey(rawMethod)];
    let note = cleanText(row.note, 500);
    if (!method) {
      method = 'other';
      warnings.push(`Method "${rawMethod}" will be recorded as Other`);
      note = cleanText(`Method: ${rawMethod}${note ? ` · ${note}` : ''}`, 500);
    }
    const reference = cleanText(row.reference, 160);

    const entry = ledgerFor(candidates[0]);
    const invoiceNumber = entry.invoice.record.number || entry.invoice.record.id;
    if (!(entry.total > 0)) { skip(row, 'Invoice has no total to pay against'); continue; }
    if (reference) {
      const seen = entry.references.get(lookupKey(reference));
      if (seen) {
        skip(row, seen === 'on file'
          ? `Duplicate: reference ${reference} is already recorded on ${invoiceNumber}`
          : `Duplicate of line ${seen}: same invoice and reference`);
        continue;
      }
    } else {
      const sameDay = payment => roundMoney(payment.amount) === amount && String(payment.receivedAt || '').slice(0, 10) === date;
      if (entry.prior.some(sameDay)) warnings.push(`Possible duplicate: a ${amount.toFixed(2)} payment on ${date} is already recorded`);
      else if (entry.batch.some(sameDay)) warnings.push(`Possible duplicate: line ${entry.batch.find(sameDay).line} has the same amount and date`);
    }
    const balanceBefore = roundMoney(entry.total - entry.paid);
    if (amount > balanceBefore) {
      skip(row, balanceBefore === 0
        ? `Overpayment: ${invoiceNumber} has no balance left`
        : `Overpayment: ${amount.toFixed(2)} is more than the ${balanceBefore.toFixed(2)} still due`);
      continue;
    }
    const balanceAfter = roundMoney(balanceBefore - amount);
    if (entry.legacyPaid && !entry.batch.length) warnings.push('Invoice was imported as paid with no payment on file; this adds the payment record');
    if (balanceAfter > 0) warnings.push(`Partial payment: ${balanceAfter.toFixed(2)} will still be due`);

    entry.paid = roundMoney(entry.paid + amount);
    if (reference) entry.references.set(lookupKey(reference), row.line);
    const item = {
      line: row.line,
      invoiceId: entry.invoice.record.id,
      invoiceNumber,
      customer: customerName(entry.invoice.record),
      amount,
      method,
      date,
      receivedAt: `${date}T12:00:00.000Z`,
      reference,
      note,
      balanceBefore,
      balanceAfter,
      warnings,
    };
    entry.batch.push(item);
    valid.push(item);
  }
  // A partial-payment warning only matters on the invoice's last row in the file.
  for (const entry of ledger.values()) {
    entry.batch.slice(0, -1).forEach(item => {
      item.warnings = item.warnings.filter(warning => !warning.startsWith('Partial payment'));
    });
  }
  return { valid, skipped, ledger };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Changes whenever the rows to post, or any invoice they touch, change. */
export async function importFingerprint(valid, ledger) {
  const invoices = [...ledger.values()]
    .filter(entry => entry.batch.length)
    .map(entry => [entry.invoice.record.id, entry.invoice.row?.updated_at || ''])
    .sort();
  const rows = valid.map(item => [item.line, item.invoiceId, item.amount, item.method, item.date, item.reference, item.note]);
  return sha256Hex(JSON.stringify({ rows, invoices }));
}

async function loadImportContext(env, shopId, rows) {
  const keys = JSON.stringify([...new Set(rows.map(row => lookupKey(row.invoice)).filter(Boolean))]);
  const invoiceRows = (await env.DB.prepare(`
    SELECT data_json, created_by, created_at, updated_at
    FROM entities
    WHERE shop_id = ? AND entity_type = 'invoices'
      AND (
        upper(trim(entity_id)) IN (SELECT value FROM json_each(?))
        OR upper(trim(COALESCE(json_extract(data_json, '$.number'), ''))) IN (SELECT value FROM json_each(?))
      )
  `).bind(shopId, keys, keys).all()).results || [];
  const invoices = invoiceRows.flatMap(row => {
    try { return [{ record: JSON.parse(row.data_json), row }]; } catch { return []; }
  });
  const numbers = JSON.stringify(invoices.map(invoice => invoice.record.number || invoice.record.id));
  const ros = JSON.stringify(invoices.map(invoice => invoice.record.ro).filter(Boolean));
  const [paymentRows, orderRows] = await Promise.all([
    env.DB.prepare(`
      SELECT data_json
      FROM entities
      WHERE shop_id = ? AND entity_type = 'payments'
        AND json_extract(data_json, '$.status') = 'completed'
        AND (
          json_extract(data_json, '$.invoiceNumber') IN (SELECT value FROM json_each(?))
          OR json_extract(data_json, '$.workOrderId') IN (SELECT value FROM json_each(?))
        )
    `).bind(shopId, numbers, ros).all(),
    env.DB.prepare(`
      SELECT data_json, created_by, created_at, updated_at
      FROM entities
      WHERE shop_id = ? AND entity_type = 'orders' AND entity_id IN (SELECT value FROM json_each(?))
    `).bind(shopId, ros).all(),
  ]);
  const payments = (paymentRows.results || []).flatMap(row => {
    try { return [JSON.parse(row.data_json)]; } catch { return []; }
  });
  const orders = new Map((orderRows.results || []).flatMap(row => {
    try {
      const record = JSON.parse(row.data_json);
      return [[record.id, { record, row }]];
    } catch { return []; }
  }));
  return { invoices, payments, orders };
}

function auditEvent(mode, fileName, { valid, skipped }, extra = {}) {
  return {
    type: 'payment_import',
    mode,
    fileName,
    rows: valid.length + skipped.length,
    posted: mode === 'commit' ? valid.length : 0,
    validRows: valid.length,
    skipped: skipped.length,
    amount: roundMoney(valid.reduce((sum, item) => sum + item.amount, 0)),
    invoices: [...new Set(valid.map(item => item.invoiceNumber))],
    skippedRows: skipped,
    ...extra,
  };
}

export async function writeImportAudit(env, context, event) {
  const id = `audit-${Date.now()}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO audit_log (id, shop_id, actor_id, actor_email, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, context.shopId, context.userId, context.email || '', JSON.stringify(event), new Date().toISOString()).run();
  return id;
}

/** Build every write for the import. Nothing runs until the caller batches them. */
async function buildImportWrites(env, context, result, orders, fileName, now) {
  const { valid, ledger } = result;
  const writes = [];
  const paymentIds = [];
  const guard = [];
  for (const entry of ledger.values()) {
    if (!entry.batch.length) continue;
    const { invoice } = entry;
    for (const item of entry.batch) {
      // A referenced payment gets an id derived from invoice + reference, so a
      // second commit of the same payment collides on the primary key.
      const id = item.reference
        ? `pay-import-${(await sha256Hex(`${context.shopId}|${invoice.record.id}|${lookupKey(item.reference)}`)).slice(0, 32)}`
        : crypto.randomUUID();
      paymentIds.push(id);
      const payment = {
        id,
        targetType: 'invoice',
        targetId: invoice.record.id,
        invoiceNumber: item.invoiceNumber,
        workOrderId: invoice.record.ro || undefined,
        customer: invoice.record.customer || '',
        amount: item.amount,
        method: item.method,
        receivedAt: item.receivedAt,
        reference: item.reference,
        note: item.note,
        status: 'completed',
        recordedBy: context.userId,
        source: 'csv_import',
        importFile: fileName,
        shopId: context.shopId,
        createdBy: context.userId,
        createdAt: now,
        updatedAt: now,
      };
      writes.push(env.DB.prepare(`
        INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
        VALUES (?, 'payments', ?, ?, ?, ?, ?)
      `).bind(context.shopId, id, JSON.stringify(payment), context.userId, now, now));
    }
    const summary = paymentStatus(entry.total, entry.paid);
    const lastReceived = [...entry.prior, ...entry.batch].map(item => item.receivedAt).filter(Boolean).sort().at(-1);
    const legacyCloseout = invoice.record.paymentImportLegacyCloseout
      || (entry.legacyPaid ? {
        paidAt: invoice.record.paidAt,
        closedAt: invoice.record.closedAt,
        closeoutSource: invoice.record.closeoutSource,
      } : null);
    // Keep the closeout dates an already-paid migrated invoice came in with, so
    // filed tax periods do not move.
    const paidAt = summary.status === 'paid'
      ? (legacyCloseout?.paidAt || lastReceived)
      : invoice.record.paidAt;
    const closedAt = summary.status === 'paid'
      ? (legacyCloseout?.closedAt || lastReceived)
      : invoice.record.closedAt;
    const closeoutSource = summary.status === 'paid'
      ? legacyCloseout?.closeoutSource || (legacyCloseout?.closedAt ? invoice.record.closeoutSource : 'payment_date')
      : invoice.record.closeoutSource;
    writes.push(entityWriteStatement(env, context, 'invoices', invoice.record.id, {
      ...invoice.record,
      ...(legacyCloseout ? { paymentImportLegacyCloseout: legacyCloseout } : {}),
      paidAmount: summary.paid,
      balanceDue: summary.balance,
      paymentStatus: summary.status,
      status: summary.status,
      paidAt,
      closedAt,
      closeoutSource,
    }, invoice.row, now).statement);
    guard.push({ type: 'invoices', id: invoice.record.id, updatedAt: invoice.row.updated_at });
    const order = invoice.record.ro ? orders.get(invoice.record.ro) : null;
    if (order) {
      writes.push(entityWriteStatement(env, context, 'orders', order.record.id, {
        ...order.record,
        paidAmount: summary.paid,
        balanceDue: summary.balance,
        paymentStatus: summary.status,
      }, order.row, now).statement);
      guard.push({ type: 'orders', id: order.record.id, updatedAt: order.row.updated_at });
    }
  }
  const auditId = `audit-${Date.now()}-${crypto.randomUUID()}`;
  const event = JSON.stringify(auditEvent('commit', fileName, result, { paymentIds }));
  // The audit row doubles as the concurrency guard and runs first in the
  // batch: if any invoice or work order changed since validation, its
  // event_json becomes invalid JSON, the CHECK constraint fails, and D1 rolls
  // the whole batch back.
  writes.unshift(env.DB.prepare(`
    INSERT INTO audit_log (id, shop_id, actor_id, actor_email, event_json, created_at)
    SELECT ?, ?, ?, ?,
      CASE WHEN (
        SELECT COUNT(*) FROM entities e JOIN json_each(?) j
          ON e.entity_type = json_extract(j.value, '$.type')
          AND e.entity_id = json_extract(j.value, '$.id')
          AND e.updated_at = json_extract(j.value, '$.updatedAt')
        WHERE e.shop_id = ?
      ) = ? THEN ? ELSE 'stale' END,
      ?
  `).bind(auditId, context.shopId, context.userId, context.email || '', JSON.stringify(guard), context.shopId, guard.length, event, now));
  return { writes, paymentIds, auditId, invoiceCount: guard.filter(item => item.type === 'invoices').length };
}

function previewRow(item) {
  const { line, invoiceNumber, customer, amount, method, date, reference, note, balanceBefore, balanceAfter, warnings } = item;
  return { line, invoiceNumber, customer, amount, method, date, reference, note, balanceBefore, balanceAfter, warnings };
}

/**
 * POST /payments/import { csv, fileName, mode: 'preview' | 'commit', dryRun, fingerprint }
 */
export async function importPayments(env, context, body) {
  const mode = body?.mode === 'commit' ? 'commit' : 'preview';
  const dryRun = mode === 'commit' && body?.dryRun === true;
  const fileName = cleanText(body?.fileName || 'payments.csv', 120);
  const rows = readPaymentCsv(body?.csv);
  const loaded = await loadImportContext(env, context.shopId, rows);
  const result = validatePaymentRows(rows, loaded);
  const fingerprint = await importFingerprint(result.valid, result.ledger);
  const totals = {
    rows: rows.length,
    valid: result.valid.length,
    skipped: result.skipped.length,
    amount: roundMoney(result.valid.reduce((sum, item) => sum + item.amount, 0)),
    invoices: new Set(result.valid.map(item => item.invoiceId)).size,
    warnings: result.valid.filter(item => item.warnings.length).length,
  };
  const response = {
    mode: dryRun ? 'dry_run' : mode,
    fileName,
    fingerprint,
    totals,
    rows: result.valid.map(previewRow),
    skippedRows: result.skipped,
  };
  if (mode === 'preview') return response;

  if (!body?.fingerprint || body.fingerprint !== fingerprint) {
    throw new HttpError(409, 'The file or the invoices changed since the preview. Preview the file again before posting.');
  }
  if (!result.valid.length) throw new HttpError(400, 'No rows in this file can be posted');
  const now = new Date().toISOString();
  const built = await buildImportWrites(env, context, result, loaded.orders, fileName, now);
  if (dryRun) {
    const auditId = await writeImportAudit(env, context, auditEvent('dry_run', fileName, result));
    return { ...response, posted: 0, wouldPost: result.valid.length, skipped: result.skipped.length, auditId };
  }
  try {
    await env.DB.batch(built.writes);
  } catch (error) {
    const message = String(error?.message || error);
    const stale = /CHECK constraint failed/i.test(message);
    const duplicate = /UNIQUE constraint failed|PRIMARY KEY/i.test(message);
    await writeImportAudit(env, context, auditEvent('failed', fileName, result, {
      error: stale ? 'stale' : duplicate ? 'duplicate' : message.slice(0, 300),
    })).catch(() => {});
    if (stale) throw new HttpError(409, 'An invoice changed while the import was posting. Nothing was saved; preview the file again.');
    if (duplicate) throw new HttpError(409, 'One of these payments was already posted. Nothing was saved; preview the file again.');
    throw new HttpError(500, 'The import could not be saved. Nothing was posted.');
  }
  return {
    ...response,
    mode: 'commit',
    posted: result.valid.length,
    skipped: result.skipped.length,
    invoicesUpdated: built.invoiceCount,
    paymentIds: built.paymentIds,
    auditId: built.auditId,
  };
}
