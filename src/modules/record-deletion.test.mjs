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

import { archivedCopy, invoiceHasActivity, isArchived, relatedForRemoval, removalAction, restoredCopy } from './record-deletion.js';

test('a draft invoice is deleted; a sent, signed or paid one is archived', () => {
  assert.equal(removalAction('invoices', { number: 'INV-1', status: 'sent' }, {}), 'delete');
  assert.equal(removalAction('invoices', { number: 'INV-1', status: 'paid' }, {}), 'archive');
  assert.equal(removalAction('invoices', { number: 'INV-1', signature: { signedAt: '2026-01-01' } }, {}), 'archive');
  assert.equal(removalAction('invoices', { number: 'INV-1' }, { documentLinks: 1 }), 'archive');
  assert.equal(invoiceHasActivity({ number: 'INV-1' }, { payments: [{}] }), true);
});

test('payments always archive; orders, vehicles and customers archive only with money attached', () => {
  assert.equal(removalAction('payments', {}, {}), 'archive');
  assert.equal(removalAction('orders', { id: 'RO-1' }, {}), 'delete');
  assert.equal(removalAction('orders', { id: 'RO-1' }, { invoices: [{}] }), 'archive');
  assert.equal(removalAction('vehicles', { id: 'v1' }, { invoices: [] }), 'delete');
  assert.equal(removalAction('customers', { name: 'A' }, { payments: [{}] }), 'archive');
  assert.equal(removalAction('appointments', {}, {}), 'delete');
});

test('relatedForRemoval finds invoices for an order, a vehicle and a customer', () => {
  const collections = {
    orders: [{ id: 'RO-1', vehicleId: 'v1', customer: 'Ann' }],
    invoices: [{ number: 'INV-1', ro: 'RO-1', customer: 'Ann' }],
    payments: [{ invoiceNumber: 'INV-1', amount: 10 }],
  };
  assert.equal(relatedForRemoval('orders', { id: 'RO-1' }, collections).invoices.length, 1);
  assert.equal(relatedForRemoval('vehicles', { id: 'v1' }, collections).invoices.length, 1);
  assert.equal(relatedForRemoval('invoices', { number: 'INV-1' }, collections).payments.length, 1);
  assert.equal(relatedForRemoval('customers', { name: 'Ann' }, collections).invoices.length, 1);
});

test('relatedForRemoval finds invoices linked directly by vehicleId', () => {
  const linked = relatedForRemoval('vehicles', { id: 'v1' }, {
    invoices: [{ id: 'INV-1', vehicleId: 'v1' }],
  });
  assert.deepEqual(linked.invoices.map(invoice => invoice.id), ['INV-1']);
});

test('archive and restore round-trip the archive fields', () => {
  const archived = archivedCopy({ id: 'x', name: 'A' }, { actor: 'o@x', at: '2026-11-01T00:00:00Z', reason: 'r', group: 'customers:x' });
  assert.ok(isArchived(archived));
  assert.equal(archived.archiveGroup, 'customers:x');
  const restored = restoredCopy(archived);
  assert.ok(!isArchived(restored));
  assert.deepEqual(restored, { id: 'x', name: 'A' });
});
