import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_TYPES, entityLabel, parseCsv, prepareImportRecords } from './imports.js';

const shop = {
  today: '2026-09-30',
  createdAt: '2026-09-30T12:00:00.000Z',
  taxRate: 8.25,
  customers: [{ name: 'Existing Customer' }],
  vehicles: [{ vin: 'TAKENVIN000000001' }],
  orders: [{ id: 'RO-1044' }],
  invoices: [{ number: 'INV-2041' }],
  estimates: [{ number: 'EST-1001' }],
};

test('every import type exposes a template that imports one valid row', () => {
  for (const [type, def] of Object.entries(IMPORT_TYPES)) {
    assert.equal(typeof def.title, 'string');
    assert.ok(def.columns && def.required && def.sample);
    const result = prepareImportRecords(type, def.sample, { today: '2026-09-30', createdAt: '2026-09-30T12:00:00.000Z', taxRate: 8.25 });
    assert.equal(result.errors.length, 0, `${type}: ${result.errors.join('; ')}`);
    assert.equal(result.records.length, 1, type);
    assert.equal(entityLabel(type).length > 0, true);
  }
});

test('parseCsv keeps quoted commas and escaped quotes', () => {
  const rows = parseCsv('name,note\n"Ada, Smith","She said ""ok"""\n');
  assert.deepEqual(rows, [['name', 'note'], ['Ada, Smith', 'She said "ok"']]);
});

test('customer import skips duplicates and rejects blank names', () => {
  const csv = 'name,phone,email\nExisting Customer,555,a@example.com\n,555-0199,blank@example.com\nNew Customer,555-0100,new@example.com\nNew Customer,555-0100,new@example.com\n=cmd|calc,806-555-0100,x@example.com';
  const result = prepareImportRecords('customers', csv, shop);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].name, 'New Customer');
  assert.equal(result.records[1].name, 'cmd|calc');
  assert.match(result.errors[0], /Customer name is required/);
  assert.equal(result.skipped, 3);
});

test('vehicle import requires identity fields and skips a known VIN', () => {
  const csv = 'customer,year,make,model,vin,plate\nDemo,2020,Ford,,VIN,ABC\nDemo,2020,Ford,Escape,takenvin000000001,ABC\nDemo,2020,Ford,Escape,NEWVIN0000000001,XYZ';
  const result = prepareImportRecords('vehicles', csv, shop);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].vin, 'NEWVIN0000000001');
  assert.match(result.errors[0], /year, make, and model/);
});

test('work order import assigns distinct numbers inside one file', () => {
  const csv = 'customer,vehicle,complaint,total\nAda,2020 Ford,Oil,89.95\nBea,2019 Honda,Brakes,not-a-number\nCara,2018 Chevy,Alignment,120';
  const result = prepareImportRecords('orders', csv, { orders: [], today: '2026-09-30' });
  assert.deepEqual(result.records.map(order => order.id), ['RO-1001', 'RO-1002']);
  assert.equal(result.records[1].total, 120);
  assert.match(result.errors[0], /Total must be a number/);
});

test('work order import skips an existing repair order number', () => {
  const csv = 'ro_number,customer,vehicle,complaint\nRO-1044,Ada,2020 Ford,Oil\nro-1053,Bea,2019 Honda,Brakes';
  const result = prepareImportRecords('orders', csv, shop);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'ro-1053');
  assert.equal(result.records[0].status, 'estimate');
});

test('invoice import keeps totals and rejects duplicates and bad money', () => {
  const csv = 'number,customer,ro,date,paid_date,due,status,subtotal,tax_rate,tax,amount\nINV-2041,Ada,RO-1,2026-09-01,,2026-09-15,sent,10,8.25,0.83,10.83\nINV-3000,Bea,RO-2,2026-09-02,2026-09-10,2026-09-16,paid,100,8.25,8.25,108.25\n,Cara,RO-3,2026-09-03,,,overdue,,, ,nope\n,Dee,RO-4,2026-09-03,,2026-09-17,void,50,8.25,4.13,54.13';
  const result = prepareImportRecords('invoices', csv, shop);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].number, 'INV-3000');
  assert.equal(result.records[0].status, 'paid');
  assert.equal(result.records[0].amount, 108.25);
  assert.equal(result.records[0].subtotal, 100);
  assert.equal(result.records[0].closedAt, '2026-09-10');
  assert.equal(result.records[0].closeoutSource, 'source_closeout_date');
  assert.equal(result.records[0].importSource, 'csv');
  assert.match(result.errors.join('\n'), /numeric invoice amount/);
  assert.match(result.errors.join('\n'), /sent, overdue, or paid/);
});

test('invoice import can assign a number and derive tax from the shop rate', () => {
  const csv = 'customer,amount,date\nAda,"$250.00",2026-09-30';
  const result = prepareImportRecords('invoices', csv, shop);
  assert.equal(result.records.length, 1);
  const invoice = result.records[0];
  assert.equal(invoice.number, 'INV-2042');
  assert.equal(invoice.amount, 250);
  assert.equal(invoice.due, '2026-10-14');
  assert.equal(invoice.closedAt, '2026-09-30');
  assert.equal(invoice.closeoutSource, 'invoice_date');
  assert.equal(invoice.taxRate, 8.25);
  assert.ok(invoice.subtotal > 0 && invoice.subtotal < invoice.amount);
});

test('invoice import rejects an invalid explicit closeout date', () => {
  const csv = 'number,customer,date,closeout_date,status,amount\nINV-3001,Ada,2026-09-02,not-a-date,paid,108.25';
  const result = prepareImportRecords('invoices', csv, shop);
  assert.equal(result.records.length, 0);
  assert.match(result.errors[0], /Closeout date must be a real date/);
});

test('estimate import builds a pending register row and skips duplicates', () => {
  const csv = 'number,customer,vehicle,summary,status,total,email\nEST-1001,Ada,2020 Ford,Brakes,pending,100,a@example.com\n,Bea,2019 Honda,Oil,approved,89.5,b@example.com\n,Cara,2018 Chevy,Alignment,maybe,40,c@example.com';
  const result = prepareImportRecords('estimates', csv, shop);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].number, 'EST-1002');
  assert.equal(result.records[0].status, 'approved');
  assert.equal(result.records[0].lines[0].service, 'Oil');
  assert.equal(result.records[0].id, 'estimate-EST-1002');
  assert.match(result.errors[0], /pending, approved, or declined/);
});

test('expense import requires a vendor and an amount', () => {
  const csv = 'date,vendor,category,memo,amount\n2026-08-14,Demo Tool Supply,Tools,Socket set,149.99\n, ,Tools,Missing,-1';
  const result = prepareImportRecords('expenses', csv, shop);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].amount, 149.99);
  assert.match(result.errors[0], /Vendor and numeric amount/);
});

test('a header-only file explains what is missing', () => {
  const result = prepareImportRecords('invoices', 'customer,amount\n', shop);
  assert.match(result.errors[0], /header row/);
});

test('unknown import types fail closed', () => {
  const result = prepareImportRecords('payroll', 'name\nAda', shop);
  assert.match(result.errors[0], /supported import type/);
});

test('customer import rejects an invalid email or phone and says which row and value', () => {
  const csv = 'name,phone,email\nGrace Holloway,806-555-0111,grace@example.com\nBad Email,806-555-0112,notanemail\nBad Phone,call me,bp@example.com\nShort Phone,555,sp@example.com\nNo Contact,,\nWith Ext,(806) 555-0113 ext 4,ext@example.com\nIntl,+44 20 7946 0958,uk@example.co.uk';
  const result = prepareImportRecords('customers', csv, { customers: [] });
  assert.deepEqual(result.records.map(record => record.name), ['Grace Holloway', 'No Contact', 'With Ext', 'Intl']);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /^Row 3: Email "notanemail" is not a valid email address$/);
  assert.match(result.errors[1], /^Row 4: Phone "call me" is not a valid phone number$/);
  assert.match(result.errors[2], /^Row 5: Phone "555" is not a valid phone number$/);
  assert.equal(result.skipped, 3);
});
