import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaxReport,
  canReadEntity,
  canWriteEntity,
  normalizeEntityPayload,
  normalizeEntityType,
  openInvoiceBalance,
  redactEmployee,
  validShopId,
  validVin,
} from '../src/domain.mjs';
import { constantTimeEqual, decryptSecret, encryptSecret, hmacHex } from '../src/security.mjs';

test('entity RBAC preserves payroll and employee protections', () => {
  assert.equal(canReadEntity('payrollentries', 'technician'), false);
  assert.equal(canWriteEntity('employees', 'technician'), false);
  assert.equal(canWriteEntity('orders', 'technician'), true);
  assert.deepEqual(redactEmployee({ name: 'A', payRate: 42, phone: 'x' }, 'technician'), { name: 'A' });
});

test('VIN and shop identifiers are validated', () => {
  assert.equal(validVin('1HGCM82633A004352'), true);
  assert.equal(validVin('1HGCM82633I004352'), false);
  assert.equal(validShopId('main-shop'), true);
  assert.equal(validShopId('../shop'), false);
});

test('legacy entity aliases remain compatible', () => {
  assert.equal(normalizeEntityType('bookings'), 'appointments');
  assert.deepEqual(normalizeEntityPayload('bookings', {
    id: '1',
    customer_id: '42',
    employee_id: '7',
    booking_date: '2026-09-08T14:30:00Z',
    service_type: 'brakes',
  }), {
    id: '1',
    customer_id: '42',
    employee_id: '7',
    booking_date: '2026-09-08T14:30:00Z',
    service_type: 'brakes',
    customerId: '42',
    employeeId: '7',
    customer: 'Customer #42',
    vehicle: 'Vehicle pending',
    service: 'brakes',
    date: '2026-09-08',
    time: '14:30',
    tech: 'Employee #7',
    notes: '',
    status: 'scheduled',
    createdAt: undefined,
    updatedAt: undefined,
  });
});

test('imported shop entities normalize into the app data model', () => {
  assert.deepEqual(normalizeEntityPayload('vehicles', {
    customer_name: 'Ada',
    vehicle_year: '2020',
    vehicle_make: 'Ford',
    vehicle_model: 'Escape',
    license_plate: 'ABC-123',
  }), {
    customer_name: 'Ada',
    vehicle_year: '2020',
    vehicle_make: 'Ford',
    vehicle_model: 'Escape',
    license_plate: 'ABC-123',
    customer: 'Ada',
    year: '2020',
    make: 'Ford',
    model: 'Escape',
    vin: '',
    plate: 'ABC-123',
    createdAt: undefined,
    updatedAt: undefined,
  });
  assert.equal(normalizeEntityPayload('expenses', {
    expense_date: '2026-09-01',
    payee: 'Tool Supply',
    total_amount: 42.5,
  }).amount, 42.5);
});

test('invoice normalization uses an explicit lifecycle date before invoice date', () => {
  const explicit = normalizeEntityPayload('invoices', {
    invoice_number: 'INV-9',
    customer_name: 'Ada',
    invoice_date: '2026-08-01',
    paid_date: '2026-08-07',
    total_amount: 108.25,
    status: 'Completed',
  });
  assert.equal(explicit.number, 'INV-9');
  assert.equal(explicit.status, 'paid');
  assert.equal(explicit.closedAt, '2026-08-07');
  assert.equal(explicit.closeoutSource, 'source_closeout_date');

  const fallback = normalizeEntityPayload('invoices', {
    number: 'INV-10',
    customer: 'Bea',
    date: '2026-08-02',
    amount: 50,
    status: 'sent',
    importSource: 'csv',
  });
  assert.equal(fallback.closedAt, '2026-08-02');
  assert.equal(fallback.closeoutSource, 'invoice_date');
});

test('invoice balance and tax report account for completed payments', () => {
  const payments = [
    { invoiceNumber: 'INV-1', customer: 'A', amount: 54.13, receivedAt: '2026-09-01T12:00:00Z', status: 'completed' },
    { invoiceNumber: 'INV-1', customer: 'A', amount: 10, receivedAt: '2026-09-02T12:00:00Z', status: 'pending' },
  ];
  assert.equal(openInvoiceBalance(108.25, payments), 54.12);
  assert.deepEqual(buildTaxReport(payments, [{ number: 'INV-1', amount: 108.25 }], 8.25, '2026-09-01', '2026-09-30').totals, {
    gross: 54.13,
    taxable: 50,
    nontaxable: 0,
    tax: 4.13,
  });
});

test('tax report includes imported paid invoices without duplicate payment rows', () => {
  const invoice = {
    number: 'INV-IMPORT-100',
    customer: 'Imported Customer',
    amount: 149.99,
    subtotal: 138.56,
    tax: 11.43,
    taxRate: 8.25,
    status: 'paid',
    date: '2026-10-01',
    closedAt: '2026-10-06',
    importSource: 'csv',
  };
  const report = buildTaxReport([], [invoice], 8.25, '2026-10-01', '2026-10-07');
  assert.deepEqual(report.rows, [{
    date: '2026-10-06',
    invoiceNumber: 'INV-IMPORT-100',
    customer: 'Imported Customer',
    gross: 149.99,
    taxable: 138.56,
    nontaxable: 0,
    tax: 11.43,
    taxRate: 8.25,
  }]);
  assert.deepEqual(report.totals, {
    gross: 149.99,
    taxable: 138.56,
    nontaxable: 0,
    tax: 11.43,
  });

  const withPayment = buildTaxReport([{
    invoiceNumber: invoice.number,
    customer: invoice.customer,
    amount: invoice.amount,
    receivedAt: '2026-10-06',
    status: 'completed',
  }], [invoice], 8.25, '2026-10-01', '2026-10-07');
  assert.equal(withPayment.rows.length, 1);
  assert.equal(withPayment.totals.gross, 149.99);
});

test('integration secrets round-trip through AES-GCM', async () => {
  const encrypted = await encryptSecret('whsec_example', 'local-test-key');
  assert.notEqual(encrypted.ciphertext, 'whsec_example');
  assert.equal(await decryptSecret(encrypted.ciphertext, encrypted.iv, 'local-test-key'), 'whsec_example');
  assert.equal(constantTimeEqual(await hmacHex('key', 'payload'), await hmacHex('key', 'payload')), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
});

test('tax report counts only the taxable subtotal as taxable sales (labor untaxed, ADR-003)', () => {
  const invoice = { number: 'INV-9', amount: 357.6, subtotal: 349.55, taxableSubtotal: 97.55, tax: 8.05, taxRate: 8.25, status: 'paid', paidAt: '2026-10-05T12:00:00Z', customer: 'Maria' };
  const report = buildTaxReport([], [invoice], 8.25, '2026-10-01', '2026-10-07');
  assert.equal(report.rows[0].taxable, 97.55);
  assert.equal(report.rows[0].tax, 8.05);
  assert.equal(report.rows[0].nontaxable, 252);
});
