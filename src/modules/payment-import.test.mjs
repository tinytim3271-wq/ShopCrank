import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../shared/html.js';
import { paymentImportConfirmText, paymentImportPanelHtml } from './payment-import.js';

const preview = {
  fingerprint: 'abc',
  totals: { rows: 3, valid: 2, skipped: 1, amount: 150, invoices: 2, warnings: 1 },
  rows: [
    { line: 2, invoiceNumber: 'INV-1', customer: 'Dana <b>Ruiz</b>', date: '2026-09-10', method: 'check', reference: 'CHK-1', amount: 100, warnings: [] },
    { line: 3, invoiceNumber: 'INV-2', customer: 'Sam Lee', date: '2026-09-11', method: 'other', reference: '', amount: 50, warnings: ['Partial payment: 20.00 will still be due'] },
  ],
  skippedRows: [{ line: 4, invoiceNumber: 'INV-404', reason: 'No invoice with this number' }],
};

test('upload state offers the file picker and template', () => {
  const html = paymentImportPanelHtml(null, { escapeHtml });
  assert.match(html, /id="payment-import-choose"/);
  assert.match(html, /id="payment-import-template"/);
});

test('preview lists valid rows with warnings, skipped rows, and post and dry-run actions', () => {
  const html = paymentImportPanelHtml({ fileName: 'old.csv', csv: 'x', preview }, { escapeHtml });
  assert.match(html, /2 of 3 payments ready/);
  assert.match(html, /Dana &lt;b&gt;Ruiz&lt;\/b&gt;/);
  assert.match(html, /Partial payment/);
  assert.match(html, /No invoice with this number/);
  assert.match(html, /id="payment-import-dry-run"/);
  assert.match(html, /Post 2 payments/);
});

test('a dry-run result says nothing was saved and still offers to post', () => {
  const html = paymentImportPanelHtml({ preview, result: { ...preview, mode: 'dry_run', wouldPost: 2, posted: 0, skipped: 1 } }, { escapeHtml });
  assert.match(html, /Dry run: 2 payments would post/);
  assert.match(html, /Nothing was saved/);
  assert.match(html, /id="payment-import-commit"/);
});

test('a committed result reports posted and skipped counts', () => {
  const html = paymentImportPanelHtml({ preview, result: { ...preview, mode: 'commit', posted: 2, skipped: 1, invoicesUpdated: 2 } }, { escapeHtml });
  assert.match(html, /2 payments posted/);
  assert.match(html, /1 row skipped/);
  assert.doesNotMatch(html, /payment-import-commit/);
});

test('confirmation names the count, total, and skipped rows', () => {
  assert.equal(paymentImportConfirmText(preview), 'Post 2 payments totaling $150.00 to 2 invoices? 1 row will be skipped. This cannot be undone from the import screen.');
});
