import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { importPayments, parsePaymentDate, readPaymentCsv } from '../src/payment-import.mjs';
import { HttpError } from '../src/http.mjs';

const SHOP = 'shop-import';
const context = { shopId: SHOP, userId: 'user-admin', email: 'admin@example.com', role: 'admin' };
const OLD = '2026-09-01T00:00:00.000Z';

function seed(db, type, record) {
  db.sqlite.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'seed', ?, ?)
  `).run(SHOP, type, record.id, JSON.stringify({ ...record, shopId: SHOP }), OLD, OLD);
}

function setup() {
  const db = createD1();
  seed(db, 'invoices', { id: 'inv-1', number: 'INV-1001', customer: 'Dana Ruiz', ro: 'RO-1', amount: 300, status: 'sent' });
  seed(db, 'invoices', { id: 'inv-2', number: 'INV-1002', customer: 'Sam Lee', amount: 120, status: 'paid' });
  seed(db, 'invoices', { id: 'inv-3', number: 'INV-1003', customer: 'Kim Ode', amount: 80, status: 'sent' });
  seed(db, 'orders', { id: 'RO-1', customer: 'Dana Ruiz', total: 300, status: 'invoiced' });
  seed(db, 'payments', {
    id: 'pay-existing', targetType: 'invoice', targetId: 'inv-3', invoiceNumber: 'INV-1003', amount: 30,
    method: 'cash', receivedAt: '2026-09-02T12:00:00.000Z', reference: 'R-77', status: 'completed',
  });
  return { db, env: { DB: db } };
}

const rows = db => db.sqlite.prepare('SELECT entity_type, entity_id, data_json FROM entities WHERE shop_id = ?').all(SHOP)
  .map(row => ({ type: row.entity_type, id: row.entity_id, ...JSON.parse(row.data_json) }));
const audits = db => db.sqlite.prepare('SELECT * FROM audit_log WHERE shop_id = ?').all(SHOP)
  .map(row => ({ ...row, event: JSON.parse(row.event_json) }));

const CSV = [
  'Invoice Number,Amount,Date Received,Payment Method,Reference,Note',
  'INV-1001,$100.00,2026-09-10,Check,CHK-501,first half',
  'inv-1001,200,9/20/2026,Visa,AUTH-9,',
  'INV-1002,120.00,2026-09-05,Cash,,',
  'INV-1003,30,2026-09-06,cash,R-77,',
  'INV-1003,50,2026-09-06,Venmo,Z-1,',
  'INV-9999,50,2026-09-06,cash,,',
  'INV-1003,abc,2026-09-06,cash,,',
  'INV-1003,10,2026-13-40,cash,,',
].join('\n');

async function preview(env, csv = CSV) {
  return importPayments(env, context, { csv, fileName: 'migrated.csv', mode: 'preview' });
}

test('dates accept ISO and US formats and reject impossible days', () => {
  assert.equal(parsePaymentDate('2026-09-05'), '2026-09-05');
  assert.equal(parsePaymentDate('9/5/2026'), '2026-09-05');
  assert.equal(parsePaymentDate('09/05/26'), '2026-09-05');
  assert.equal(parsePaymentDate('2026-02-30'), '');
  assert.equal(parsePaymentDate('yesterday'), '');
});

test('a CSV without the required columns is rejected with their names', () => {
  assert.throws(() => readPaymentCsv('invoice,amount\nINV-1,10'), error => error instanceof HttpError
    && error.status === 400 && /date received, payment method/.test(error.message));
});

test('preview validates every row and writes nothing', async () => {
  const { db, env } = setup();
  const before = rows(db);
  const result = await preview(env);
  assert.equal(result.mode, 'preview');
  assert.deepEqual(result.rows.map(row => [row.line, row.invoiceNumber, row.amount, row.method]), [
    [2, 'INV-1001', 100, 'check'],
    [3, 'INV-1001', 200, 'card'],
    [4, 'INV-1002', 120, 'cash'],
    [6, 'INV-1003', 50, 'other'],
  ]);
  const byLine = Object.fromEntries(result.rows.map(row => [row.line, row]));
  assert.equal(byLine[2].customer, 'Dana Ruiz');
  assert.ok(byLine[2].warnings.length === 0, 'the later row on the same invoice carries the balance');
  assert.equal(byLine[3].balanceAfter, 0);
  assert.match(byLine[4].warnings.join(' '), /imported as paid/);
  assert.match(byLine[6].warnings.join(' '), /Venmo.*Other/);
  assert.match(byLine[6].note, /Method: Venmo/);
  const skipped = Object.fromEntries(result.skippedRows.map(row => [row.line, row.reason]));
  assert.match(skipped[5], /Duplicate: reference R-77 is already recorded/);
  assert.match(skipped[7], /No invoice/);
  assert.match(skipped[8], /must be a number/);
  assert.match(skipped[9], /not a valid date/);
  assert.equal(result.totals.valid, 4);
  assert.equal(result.totals.skipped, 4);
  assert.equal(result.totals.amount, 470);
  assert.deepEqual(rows(db), before);
  assert.equal(audits(db).length, 0);
});

test('overpayment and in-file duplicate references are skipped', async () => {
  const { env } = setup();
  const result = await preview(env, [
    'invoice,amount,date,method,reference',
    'INV-1003,40,2026-09-06,cash,A-1',
    'INV-1003,40,2026-09-07,cash,A-1',
    'INV-1003,20,2026-09-08,cash,A-2',
    'INV-1001,50,2026-09-06,cash,',
  ].join('\n'));
  const skipped = Object.fromEntries(result.skippedRows.map(row => [row.line, row.reason]));
  assert.match(skipped[3], /Duplicate of line 2/);
  assert.match(skipped[4], /Overpayment: 20.00 is more than the 10.00 still due/);
  assert.match(result.rows.find(row => row.line === 5).warnings.join(' '), /Partial payment: 250.00/);
});

test('commit posts every payment, updates balances and logs the audit entry in one batch', async () => {
  const { db, env } = setup();
  const { fingerprint } = await preview(env);
  const result = await importPayments(env, context, { csv: CSV, fileName: 'migrated.csv', mode: 'commit', fingerprint });
  assert.equal(result.mode, 'commit');
  assert.equal(result.posted, 4);
  assert.equal(result.skipped, 4);
  assert.equal(result.invoicesUpdated, 3);
  const all = rows(db);
  const payments = all.filter(row => row.type === 'payments' && row.source === 'csv_import');
  assert.equal(payments.length, 4);
  assert.ok(payments.every(payment => payment.status === 'completed' && payment.recordedBy === 'user-admin'));
  const invoice = id => all.find(row => row.type === 'invoices' && row.id === id);
  assert.equal(invoice('inv-1').paymentStatus, 'paid');
  assert.equal(invoice('inv-1').paidAt, '2026-09-20T12:00:00.000Z');
  assert.equal(invoice('inv-2').paymentStatus, 'paid');
  assert.equal(invoice('inv-3').paymentStatus, 'paid');
  assert.equal(invoice('inv-3').balanceDue, 0);
  assert.equal(all.find(row => row.type === 'orders' && row.id === 'RO-1').paymentStatus, 'paid');
  const [audit] = audits(db);
  assert.equal(audit.id, result.auditId);
  assert.equal(audit.actor_id, 'user-admin');
  assert.equal(audit.event.type, 'payment_import');
  assert.equal(audit.event.mode, 'commit');
  assert.equal(audit.event.posted, 4);
  assert.equal(audit.event.skippedRows.length, 4);
  assert.deepEqual(audit.event.paymentIds.sort(), payments.map(payment => payment.id).sort());

  // Posting the same file again: the referenced rows are now duplicates.
  const again = await preview(env);
  assert.equal(again.rows.filter(row => row.line === 2 || row.line === 3).length, 0);
  assert.ok(again.skippedRows.some(row => row.line === 2 && /already recorded/.test(row.reason)));
});

test('partial imports preserve migrated closeout dates and provenance when a later import completes payment', async () => {
  const { db, env } = setup();
  const paidAt = '2025-03-15T12:00:00.000Z';
  const closedAt = '2025-03-17T12:00:00.000Z';
  db.sqlite.prepare('UPDATE entities SET data_json = json_set(data_json, ?, ?, ?, ?, ?, ?) WHERE entity_id = ?')
    .run('$.paidAt', paidAt, '$.closedAt', closedAt, '$.closeoutSource', 'source_closeout_date', 'inv-2');

  const partialCsv = 'invoice,amount,date,method\nINV-1002,40,2026-09-05,cash';
  const firstPreview = await preview(env, partialCsv);
  await importPayments(env, context, {
    csv: partialCsv,
    fileName: 'first.csv',
    mode: 'commit',
    fingerprint: firstPreview.fingerprint,
  });

  let invoice = rows(db).find(row => row.type === 'invoices' && row.id === 'inv-2');
  assert.equal(invoice.paymentStatus, 'partial');
  assert.deepEqual(invoice.paymentImportLegacyCloseout, {
    paidAt,
    closedAt,
    closeoutSource: 'source_closeout_date',
  });

  const completionCsv = 'invoice,amount,date,method\nINV-1002,80,2026-10-05,cash';
  const completionPreview = await preview(env, completionCsv);
  await importPayments(env, context, {
    csv: completionCsv,
    fileName: 'second.csv',
    mode: 'commit',
    fingerprint: completionPreview.fingerprint,
  });

  invoice = rows(db).find(row => row.type === 'invoices' && row.id === 'inv-2');
  assert.equal(invoice.paymentStatus, 'paid');
  assert.equal(invoice.paidAt, paidAt);
  assert.equal(invoice.closedAt, closedAt);
  assert.equal(invoice.closeoutSource, 'source_closeout_date');
});

test('dry run validates and logs but writes no payments', async () => {
  const { db, env } = setup();
  const before = rows(db);
  const { fingerprint } = await preview(env);
  const result = await importPayments(env, context, { csv: CSV, fileName: 'migrated.csv', mode: 'commit', dryRun: true, fingerprint });
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.posted, 0);
  assert.equal(result.wouldPost, 4);
  assert.deepEqual(rows(db), before);
  const [audit] = audits(db);
  assert.equal(audit.event.mode, 'dry_run');
});

test('commit refuses a fingerprint from a different preview', async () => {
  const { db, env } = setup();
  await assert.rejects(
    importPayments(env, context, { csv: CSV, mode: 'commit', fingerprint: 'stale' }),
    error => error.status === 409,
  );
  assert.equal(rows(db).filter(row => row.source === 'csv_import').length, 0);
});

test('an invoice changed mid-commit rolls back every write', async () => {
  const { db, env } = setup();
  const { fingerprint } = await preview(env);
  const batch = db.batch.bind(db);
  db.batch = async (statements) => {
    db.sqlite.prepare("UPDATE entities SET updated_at = '2026-10-01T00:00:00.000Z' WHERE entity_id = 'inv-3'").run();
    return batch(statements);
  };
  await assert.rejects(
    importPayments(env, context, { csv: CSV, fileName: 'migrated.csv', mode: 'commit', fingerprint }),
    error => error.status === 409 && /Nothing was saved/.test(error.message),
  );
  assert.equal(rows(db).filter(row => row.source === 'csv_import').length, 0);
  assert.equal(rows(db).find(row => row.id === 'inv-1').paymentStatus, undefined);
  const [audit] = audits(db);
  assert.equal(audit.event.mode, 'failed');
  assert.equal(audit.event.error, 'stale');
});
