import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  CUSTOMER_SEARCH_MIN_LENGTH,
  customerContactChanged,
  customerContactFields,
  likelyDuplicateCustomers,
  localCustomerMatches,
  mergeSavedCustomer,
  shouldSearchCustomers,
} from './customer-intake.js';

const customers = [
  { id: 'customer-1', name: 'Isaac Gallardo', phone: '(555) 111-2222', email: 'isaac@example.com' },
  { id: 'customer-2', name: 'Gail Isaacson', phone: '555-999-1000', email: 'gail@example.com' },
];
const vehicles = [
  { id: 'vehicle-1', customerId: 'customer-1', year: 2022, make: 'Ford', model: 'F-150' },
];

test('live customer search starts only at three trimmed characters', () => {
  assert.equal(CUSTOMER_SEARCH_MIN_LENGTH, 3);
  assert.equal(CUSTOMER_SEARCH_DEBOUNCE_MS, 275);
  assert.equal(shouldSearchCustomers(' g '), false);
  assert.equal(shouldSearchCustomers(' ga '), false);
  assert.equal(shouldSearchCustomers(' gal '), true);
});

test('local fallback partially matches any name token in either order', () => {
  assert.deepEqual(localCustomerMatches('gall', customers, vehicles).map(item => item.id), ['customer-1']);
  assert.deepEqual(localCustomerMatches('gall isa', customers, vehicles).map(item => item.id), ['customer-1']);
  assert.deepEqual(localCustomerMatches('isa gall', customers, vehicles).map(item => item.id), ['customer-1']);
  assert.equal(localCustomerMatches('ga', customers, vehicles).length, 0);
  assert.equal(localCustomerMatches('gall', customers, vehicles)[0].recentVehicle.label, '2022 Ford F-150');
});

test('local customer lookups omit archived customers', () => {
  const archived = {
    id: 'customer-archived',
    name: 'Isaac Archived',
    phone: '555-111-2222',
    email: 'isaac@example.com',
    archivedAt: '2026-10-01T00:00:00.000Z',
  };
  assert.deepEqual(localCustomerMatches('archived', [archived]).map(item => item.id), []);
  assert.deepEqual(likelyDuplicateCustomers({ phone: '555-111-2222' }, [archived]), []);
});

test('likely duplicate detection normalizes phone and email', () => {
  assert.deepEqual(
    likelyDuplicateCustomers({ phone: '555-111-2222' }, customers, vehicles).map(item => item.id),
    ['customer-1'],
  );
  assert.deepEqual(
    likelyDuplicateCustomers({ email: ' ISAAC@EXAMPLE.COM ' }, customers, vehicles).map(item => item.id),
    ['customer-1'],
  );
  assert.equal(
    likelyDuplicateCustomers(
      { phone: '555-111-2222' },
      [...customers, { ...customers[0] }],
      vehicles,
    ).length,
    1,
  );
});

test('customer contact fields keep phone, email, and billing address', () => {
  assert.deepEqual(customerContactFields({
    name: '  Ada Lovelace ',
    phone: ' 555-0100 ',
    email: ' ada@example.com ',
    billingAddress: ' 12 Main St ',
    billingNotes: ' Net 15 ',
  }), {
    name: 'Ada Lovelace',
    phone: '555-0100',
    email: 'ada@example.com',
    billingAddress: '12 Main St',
    billingNotes: 'Net 15',
  });
  assert.equal(customerContactFields({ name: 'Ada', phone: undefined, email: undefined, billingAddress: undefined }).phone, '');
  assert.equal(
    customerContactFields({ name: 'Ada', phone: '555', email: 'ada@example.com', billingAddress: '12 Main' }, { billingNotes: 'Keep me' }).billingNotes,
    'Keep me',
  );
});

test('customer contact changes detect edited phone, email, and billing address', () => {
  const existing = { name: 'Ada', phone: '555', email: 'ada@example.com', billingAddress: '12 Main', billingNotes: '' };
  assert.equal(customerContactChanged(existing, existing), false);
  assert.equal(customerContactChanged(existing, { ...existing, email: 'new@example.com' }), true);
  assert.equal(customerContactChanged(null, existing), true);
});

test('saved customer merge keeps contact fields the server omitted', () => {
  const record = { id: 'c1', name: 'Ada', phone: '555', email: 'ada@example.com', billingAddress: '12 Main', billingNotes: 'Net 15' };
  assert.deepEqual(mergeSavedCustomer(record, { id: 'c1', name: 'Ada', phone: '555' }).email, 'ada@example.com');
  assert.equal(mergeSavedCustomer(record, { queued: true }).billingAddress, '12 Main');
  assert.equal(mergeSavedCustomer(record, { ...record, email: '' }).email, '');
});
