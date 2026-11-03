import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteRecords,
  customerLinkedRecords,
  describeLinkedCounts,
  hasLinkedRecords,
  requiresAdminDelete,
} from './record-deletion.js';

test('only owners and admins can delete records', () => {
  for (const role of ['owner', 'admin', 'super_admin']) assert.equal(canDeleteRecords(role), true, role);
  for (const role of ['office', 'service_writer', 'technician', '', undefined, null]) assert.equal(canDeleteRecords(role), false, String(role));
});

test('customers, vehicles, work orders, invoices and payments need an admin to delete', () => {
  for (const type of ['customers', 'vehicles', 'orders', 'invoices', 'payments']) assert.equal(requiresAdminDelete(type), true, type);
  for (const type of ['inventory', 'appointments', 'chatmessages', 'services']) assert.equal(requiresAdminDelete(type), false, type);
});

test('customerLinkedRecords finds history by name and payments on the customer invoices', () => {
  const customer = { id: 'c1', name: 'Dana Ruiz' };
  const linked = customerLinkedRecords(customer, {
    vehicles: [{ id: 'v1', customer: 'Dana Ruiz' }, { id: 'v2', customer: 'Someone Else' }],
    orders: [{ id: 'RO-1', customer: 'Dana Ruiz' }],
    invoices: [{ id: 'i1', number: 'INV-1', customer: 'Dana Ruiz' }],
    payments: [
      { id: 'p1', invoiceNumber: 'INV-1' },
      { id: 'p2', customer: 'Dana Ruiz' },
      { id: 'p3', invoiceNumber: 'INV-9', customer: 'Someone Else' },
    ],
  });
  assert.deepEqual(linked.vehicles.map(row => row.id), ['v1']);
  assert.deepEqual(linked.orders.map(row => row.id), ['RO-1']);
  assert.deepEqual(linked.payments.map(row => row.id).sort(), ['p1', 'p2']);
  assert.deepEqual(linked.estimates, []);
  assert.equal(hasLinkedRecords(linked), true);
  assert.equal(describeLinkedCounts(linked), '1 vehicle, 1 work order, 1 invoice and 2 payments');
});

test('a customer with no history has nothing linked', () => {
  const linked = customerLinkedRecords({ name: 'New Person' }, { vehicles: [{ customer: 'Other' }] });
  assert.equal(hasLinkedRecords(linked), false);
  assert.equal(describeLinkedCounts(linked), '');
  assert.equal(hasLinkedRecords(customerLinkedRecords({ name: '' }, { vehicles: [{ customer: '' }] })), false);
});
