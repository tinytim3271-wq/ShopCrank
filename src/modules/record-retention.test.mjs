import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archivedRecord,
  canDeleteRecords,
  countLinksInCollections,
  deletionPlan,
  isArchived,
} from './record-retention.js';

test('only owners and admins can delete records', () => {
  assert.equal(canDeleteRecords('owner'), true);
  assert.equal(canDeleteRecords('admin'), true);
  for (const role of ['service_writer', 'office', 'technician', 'super_admin', '', undefined]) {
    assert.equal(canDeleteRecords(role), false, String(role));
  }
});

test('financial record types always archive', () => {
  for (const type of ['invoices', 'payments', 'expenses', 'payrollentries', 'purchases']) {
    assert.equal(deletionPlan(type, { id: 'x' }).action, 'archive', type);
  }
});

test('work orders archive once invoiced, paid against, or on payroll; otherwise delete', () => {
  const order = { id: 'RO-1', customer: 'Pat', status: 'in_progress' };
  assert.equal(deletionPlan('orders', order, countLinksInCollections('orders', order, {})).action, 'delete');
  assert.equal(deletionPlan('orders', { ...order, status: 'invoiced' }).action, 'archive');
  for (const [type, row] of [
    ['invoices', { ro: 'RO-1' }],
    ['payments', { workOrderId: 'RO-1' }],
    ['payrollentries', { workOrderId: 'RO-1' }],
  ]) {
    const plan = deletionPlan('orders', order, countLinksInCollections('orders', order, { [type]: [row] }));
    assert.equal(plan.action, 'archive', type);
  }
});

test('customers archive with history, block on vehicles alone, delete when unlinked', () => {
  const customer = { id: 'Pat', name: 'Pat' };
  const plan = collections => deletionPlan('customers', customer, countLinksInCollections('customers', customer, collections));
  assert.equal(plan({}).action, 'delete');
  const blocked = plan({ vehicles: [{ customer: 'Pat' }, { customer: 'Pat' }] });
  assert.equal(blocked.action, 'blocked');
  assert.match(blocked.message, /2 vehicles/);
  const archived = plan({ vehicles: [{ customer: 'Pat' }], invoices: [{ customer: 'Pat' }], payments: [{ customer: 'Pat' }, { customer: 'Pat' }] });
  assert.equal(archived.action, 'archive');
  assert.deepEqual(archived.reasons, ['linked to 1 invoice', 'linked to 2 payments']);
});

test('archived invoices still count as financial ties', () => {
  const customer = { name: 'Pat' };
  const counts = countLinksInCollections('customers', customer, { invoices: [{ customer: 'Pat', archivedAt: '2026-10-01' }] });
  assert.equal(deletionPlan('customers', customer, counts).action, 'archive');
});

test('vehicles archive when a work order references them by id or VIN', () => {
  const vehicle = { id: 'veh-1', vin: 'VIN123' };
  const plan = rows => deletionPlan('vehicles', vehicle, countLinksInCollections('vehicles', vehicle, { orders: rows }));
  assert.equal(plan([]).action, 'delete');
  assert.equal(plan([{ vehicleId: 'veh-1' }]).action, 'archive');
  assert.equal(plan([{ vin: 'VIN123' }]).action, 'archive');
  assert.equal(deletionPlan('vehicles', { id: 'veh-2', vin: '' }, countLinksInCollections('vehicles', { id: 'veh-2', vin: '' }, { orders: [{ vin: '' }] })).action, 'delete');
});

test('signed or approved estimates archive', () => {
  assert.equal(deletionPlan('estimates', { id: 'E1', status: 'draft' }).action, 'delete');
  assert.equal(deletionPlan('estimates', { id: 'E1', status: 'approved' }).action, 'archive');
  assert.equal(deletionPlan('estimates', { id: 'E1', signatureKey: 'shops/a/sig.png' }).action, 'archive');
});

test('archivedRecord stamps the archive and deactivates records that have an active flag', () => {
  const employee = archivedRecord({ id: 'emp', active: true }, { actor: 'owner@shop.test', at: '2026-10-31T00:00:00.000Z', reasons: ['r'] });
  assert.deepEqual(employee, { id: 'emp', active: false, archivedAt: '2026-10-31T00:00:00.000Z', archivedBy: 'owner@shop.test', archiveReasons: ['r'] });
  assert.equal(isArchived(employee), true);
  assert.equal('active' in archivedRecord({ id: 'inv' }), false);
  assert.equal(isArchived({ archivedAt: null }), false);
});
