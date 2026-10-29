import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImportRecords } from './imports.js';
import { SOURCE_OPTIONS, detectSourceSystem, mapExportToCanonicalCsv, normalizeHeader } from './import-mappers.js';

const opts = { taxRate: 8.25, today: '2026-10-29', createdAt: '2026-10-29T00:00:00.000Z' };
const run = (source, type, csv) => prepareImportRecords(type, mapExportToCanonicalCsv(source, type, csv).csv, opts);

test('headers normalize the way exports spell them', () => {
  assert.equal(normalizeHeader('RO #'), 'ro_number');
  assert.equal(normalizeHeader('Repair Order #'), 'repair_order_number');
  assert.equal(normalizeHeader(' E-Mail '), 'e_mail');
  assert.equal(SOURCE_OPTIONS.length, 6);
});

test('Tekmetric customers, vehicles and posted repair orders', () => {
  const customers = run('tekmetric', 'customers', 'First Name,Last Name,Email,Phone Number,Notes\nAlice,Brooks,alice@example.com,(806) 555-0101,VIP\nBen,Carter,,806-555-0102,');
  assert.deepEqual(customers.records.map(record => [record.name, record.phone, record.email]), [['Alice Brooks', '(806) 555-0101', 'alice@example.com'], ['Ben Carter', '806-555-0102', '']]);
  const vehicles = run('tekmetric', 'vehicles', 'Customer First Name,Customer Last Name,Year,Make,Model,VIN,License Plate\nAlice,Brooks,2019,Toyota,Camry,4T1B11HK5KU123456,ABC123');
  assert.equal(vehicles.records[0].customer, 'Alice Brooks');
  assert.equal(vehicles.records[0].vin, '4T1B11HK5KU123456');
  const orders = run('tekmetric', 'orders', 'Repair Order #,Customer First Name,Customer Last Name,Year,Make,Model,Concerns,Status,Total,Posted Date\n1042,Alice,Brooks,2019,Toyota,Camry,Brake noise,Posted,"1,234.50",2026-09-01');
  assert.equal(orders.errors.length, 0, orders.errors.join('; '));
  assert.equal(orders.records[0].vehicle, '2019 Toyota Camry');
  assert.equal(orders.records[0].status, 'invoiced');
  assert.equal(orders.records[0].complaint, 'Brake noise');
  assert.equal(detectSourceSystem('Repair Order #,Posted Date,Total\n1,2026-01-01,5'), 'tekmetric');
});

test('Shopmonkey orders and invoices', () => {
  const orders = run('shopmonkey', 'orders', 'Order #,Order Name,Customer,Vehicle,Status,Total\n5001,Front brakes,Ben Carter,2021 Ford F-150,Work-in-Progress,450');
  assert.equal(orders.records[0].status, 'in_progress');
  assert.equal(orders.records[0].complaint, 'Front brakes');
  const invoices = run('shopmonkey', 'invoices', 'Invoice #,Order #,Customer,Created Date,Status,Subtotal,Tax,Total\nINV-77,5001,Ben Carter,2026-09-03,Paid,415.00,34.24,449.24');
  assert.equal(invoices.errors.length, 0, invoices.errors.join('; '));
  assert.equal(invoices.records[0].status, 'paid');
  assert.equal(invoices.records[0].amount, 449.24);
});

test('AutoLeap and Shop-Ware customers', () => {
  assert.equal(run('autoleap', 'customers', 'Customer Name,Mobile,Email\nCara Diaz,8065550103,cara@example.com').records[0].name, 'Cara Diaz');
  assert.equal(run('shopware', 'customers', 'Customer First,Customer Last,Phone,Email\nDan,Evans,8065550104,').records[0].name, 'Dan Evans');
  assert.equal(detectSourceSystem('Customer First,Customer Last,Phone\nA,B,1'), 'shopware');
});

test('Mitchell 1 "Last, First" names, cell phones, plates and total sale', () => {
  const customers = run('mitchell1', 'customers', 'Customer Name,Home Phone,Cell Phone,E-Mail\n"Evans, Dana",,806-555-0105,dana@example.com');
  assert.deepEqual([customers.records[0].name, customers.records[0].phone, customers.records[0].email], ['Dana Evans', '806-555-0105', 'dana@example.com']);
  const vehicles = run('mitchell1', 'vehicles', 'Customer Name,Year,Make,Model,VIN,Lic Plate\n"Evans, Dana",2015,Honda,Civic,2HGFB2F50FH500001,XYZ9');
  assert.equal(vehicles.records[0].plate, 'XYZ9');
  const invoices = run('mitchell1', 'invoices', 'Invoice #,RO #,Customer Name,Invoice Date,Status,Total Sale\n9001,8001,"Evans, Dana",09/04/2026,Finalized,312.40');
  assert.equal(invoices.records[0].customer, 'Dana Evans');
  assert.equal(invoices.records[0].amount, 312.4);
  assert.equal(invoices.records[0].ro, '8001');
});

test('the ShopCrank template passes through untouched; formula-looking cells stay neutralized', () => {
  const csv = 'name,phone,email\nAlice,1,a@example.com';
  assert.equal(mapExportToCanonicalCsv('shopcrank', 'customers', csv).csv, csv);
  const result = run('tekmetric', 'customers', 'First Name,Last Name\n=HYPERLINK("x"),Brooks');
  assert.doesNotMatch(result.records[0].name, /^=/);
});

test('review fixes: posted or AR invoices stay open unless paid; estimate decisions survive', () => {
  const tek = run('tekmetric', 'invoices', 'Repair Order #,Customer First Name,Customer Last Name,Posted Date,Status,Total,Balance Due\n1,A,B,2026-09-01,Accounts Receivable,100,100\n2,C,D,2026-09-01,Posted,50,0');
  assert.deepEqual(tek.records.map(record => record.status), ['sent', 'paid']);
  const estimates = run('shopmonkey', 'estimates', 'Order #,Customer,Vehicle,Status,Total\nE1,A B,2020 Civic,Approved,100\nE2,C D,2020 Civic,Declined,80\nE3,E F,2020 Civic,Open,60');
  assert.deepEqual(estimates.records.map(record => record.status), ['approved', 'declined', 'pending']);
});

test('review fixes: partly paid invoices are flagged, not imported as unpaid; paid dates become closeout dates', () => {
  const mapped = mapExportToCanonicalCsv('tekmetric', 'invoices', 'Repair Order #,Customer First Name,Customer Last Name,Posted Date,Paid Date,Status,Total,Balance Due\n1,A,B,2026-09-01,2026-10-05,Paid,200,0\n2,C,D,2026-09-01,,Accounts Receivable,200,50');
  assert.equal(mapped.rejected.length, 1);
  assert.match(mapped.rejected[0], /partly paid \(50 of 200 open\)/);
  const result = prepareImportRecords('invoices', mapped.csv, opts);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].closedAt, '2026-10-05');
  assert.equal(result.records[0].closeoutSource, 'source_closeout_date');
});
