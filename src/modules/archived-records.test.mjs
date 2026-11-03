import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemovalResult, archivedRecordLabel } from './archived-records.js';

test('an archive response removes the archived and deleted records from the lists', () => {
  const state = { invoices: [{ id: 'i1', number: 'INV-1' }, { id: 'i2', number: 'INV-2' }], payments: [{ id: 'p1' }, { id: 'p2' }], appointments: [{ id: 'a1' }] };
  const archived = applyRemovalResult(state, { action: 'archive', archived: { invoices: ['INV-1'], payments: ['p1'] }, deleted: { appointments: ['a1'] } });
  assert.equal(archived, true);
  assert.deepEqual(state.invoices.map(i => i.id), ['i2']);
  assert.deepEqual(state.payments.map(p => p.id), ['p2']);
  assert.deepEqual(state.appointments, []);
});

test('a permanent delete (204, no body) leaves the lists for the caller to update', () => {
  const state = { invoices: [{ id: 'i1' }] };
  assert.equal(applyRemovalResult(state, null), false);
  assert.equal(applyRemovalResult(state, { queued: true }), false);
  assert.equal(state.invoices.length, 1);
});

test('labels read well for each type', () => {
  assert.equal(archivedRecordLabel('invoices', { number: 'INV-9', customer: 'Ann', amount: 12.5 }), 'INV-9 · Ann · $12.50');
  assert.equal(archivedRecordLabel('vehicles', { year: 2019, make: 'Ford', model: 'F-150' }), '2019 Ford F-150');
  assert.equal(archivedRecordLabel('customers', { name: 'Ann' }), 'Ann');
});
