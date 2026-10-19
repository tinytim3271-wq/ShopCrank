import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQboIdempotencyKey,
  mapCustomerToQbo,
  mapInvoiceToQbo,
  mapPaymentToQbo,
  quickbooksConnectionStatus,
} from './quickbooks.js';

test('quickbooks fails closed until tokens exist', () => {
  assert.equal(quickbooksConnectionStatus(null).connected, false);
  assert.equal(quickbooksConnectionStatus({ realmId: '1' }).connected, false);
  assert.equal(quickbooksConnectionStatus({
    realmId: '123', refreshToken: 'rt',
  }).connected, true);
});

test('idempotency keys are stable and maps validate', () => {
  assert.equal(
    buildQboIdempotencyKey('shop', 'invoice', 'INV-1'),
    'shop|invoice|INV-1|upsert',
  );
  const customer = mapCustomerToQbo({ name: 'Pat', email: 'pat@example.com' });
  assert.equal(customer.DisplayName, 'Pat');
  const invoice = mapInvoiceToQbo({
    number: 'INV-1',
    lines: [{ description: 'Labor', total: 100, quantity: 1, unitPrice: 100 }],
  }, '55');
  assert.equal(invoice.CustomerRef.value, '55');
  assert.equal(invoice.Line.length, 1);
  const payment = mapPaymentToQbo({ amount: 100, id: 'p1' }, '55', '9');
  assert.equal(payment.TotalAmt, 100);
  assert.equal(payment.Line[0].LinkedTxn[0].TxnId, '9');
});

test('mapping rejects incomplete payloads instead of faking', () => {
  assert.throws(() => mapCustomerToQbo({}), /name/i);
  assert.throws(() => mapInvoiceToQbo({ lines: [] }, '1'), /line/i);
  assert.throws(() => mapPaymentToQbo({ amount: 0 }, '1'), /amount/i);
});

test('mapInvoiceToQbo uses hours x rate for labor and applies company tax mode', async () => {
  const { mapInvoiceToQbo } = await import('./quickbooks.js');
  const payload = mapInvoiceToQbo({
    number: 'INV-1',
    tax: 28.88,
    lines: [
      { type: 'labor', description: 'Diag', quantity: 1, hours: 2.5, laborRate: 140, unitPrice: 0, total: 350 },
      { type: 'part', description: 'Declined', quantity: 1, unitPrice: 10, total: 10, approvalStatus: 'declined' },
    ],
  }, 'c-1', { tax: { mode: 'manual', taxCodeId: '3' } });
  assert.equal(payload.Line.length, 1);
  assert.deepEqual(payload.Line[0].SalesItemLineDetail, { Qty: 2.5, UnitPrice: 140, TaxCodeRef: { value: 'TAX' } });
  assert.deepEqual(payload.TxnTaxDetail, { TxnTaxCodeRef: { value: '3' }, TotalTax: 28.88 });
});

test('company tax mode detection and tax code auto-selection', async () => {
  const { qboTaxModeFromCompany, resolveQboTaxSettings } = await import('./quickbooks.js');
  const us = { CompanyInfo: { Country: 'US' } };
  assert.equal(qboTaxModeFromCompany({ preferences: { Preferences: { TaxPrefs: { PartnerTaxEnabled: true } } }, companyInfo: us }), 'ast');
  assert.equal(qboTaxModeFromCompany({ preferences: { Preferences: { TaxPrefs: { UsingSalesTax: true } } }, companyInfo: us }), 'manual');
  assert.equal(qboTaxModeFromCompany({ preferences: {}, companyInfo: us }), 'none');
  assert.equal(qboTaxModeFromCompany({ preferences: {}, companyInfo: { CompanyInfo: { Country: 'CA' } } }), 'global');
  const codes = [{ Id: 'TAX' }, { Id: 'NON', Taxable: false }, { Id: '3', Taxable: true }, { Id: '5', Taxable: true }];
  assert.equal(resolveQboTaxSettings('manual', codes, {}).taxCodeId, null);
  assert.equal(resolveQboTaxSettings('manual', codes, { taxCodeId: '5' }).taxCodeId, '5');
  assert.equal(resolveQboTaxSettings('manual', codes, { taxCodeId: 'gone' }).taxCodeId, null);
  assert.equal(resolveQboTaxSettings('manual', codes.slice(0, 3), {}).taxCodeId, '3');
});

test('panel shows connected from the server status, which never includes tokens', async () => {
  const { quickbooksPanelHtml } = await import('./quickbooks.js');
  const html = quickbooksPanelHtml({ connected: true, status: 'connected', realmId: '9130' }, { canSave: true });
  assert.match(html, /QuickBooks Online connected/);
  assert.match(html, /qbo-disconnect/);
});
