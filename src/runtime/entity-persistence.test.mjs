import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueuedEntityMutations, persistMutationQueue } from './entity-persistence.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('mutation queues are retained until every write is synced', () => {
  const storage = memoryStorage();
  const queue = [{ path: '/entities/customers', method: 'POST', body: '{"id":"customer-1"}' }];
  persistMutationQueue(storage, 'queue', queue);
  assert.deepEqual(JSON.parse(storage.getItem('queue')), queue);

  persistMutationQueue(storage, 'queue', []);
  assert.equal(storage.getItem('queue'), null);
});

test('queued customer and order writes remain visible over stale server lists', () => {
  const queue = [
    {
      path: '/entities/customers',
      method: 'POST',
      body: JSON.stringify({ id: 'customer-2', name: 'Lee Customer' }),
    },
    {
      path: '/entities/orders/RO-2',
      method: 'PUT',
      body: JSON.stringify({ id: 'RO-2', tech: 'Lee Tech' }),
    },
  ];
  assert.deepEqual(
    applyQueuedEntityMutations('customers', [{ id: 'customer-1', name: 'Existing' }], queue),
    [
      { id: 'customer-1', name: 'Existing' },
      { id: 'customer-2', name: 'Lee Customer' },
    ],
  );
  assert.deepEqual(
    applyQueuedEntityMutations('orders', [{ id: 'RO-2', tech: 'Unassigned' }], queue),
    [{ id: 'RO-2', tech: 'Lee Tech' }],
  );
});

test('queued deletes hide records while waiting to sync', () => {
  const queue = [{ path: '/entities/customers/customer-1', method: 'DELETE' }];
  assert.deepEqual(
    applyQueuedEntityMutations('customers', [{ id: 'customer-1', name: 'Existing' }], queue),
    [],
  );
});

test('queued archives retain archived records over remote lists', () => {
  const archivedRecord = { id: 'customer-1', name: 'Existing', archivedAt: '2026-10-31T12:00:00.000Z' };
  const latestRemote = { id: 'customer-1', name: 'Updated', phone: '555-0100' };
  const queue = [{
    path: '/entities/customers/customer-1',
    method: 'DELETE',
    archivedRecord,
  }];
  assert.deepEqual(
    applyQueuedEntityMutations('customers', [latestRemote], queue),
    [{ ...latestRemote, archivedAt: archivedRecord.archivedAt }],
  );
  assert.deepEqual(
    applyQueuedEntityMutations('customers', [], queue),
    [archivedRecord],
  );
});

test('API entity types overlay even when UI state keys differ', () => {
  const queue = [{
    path: '/entities/inspectiontemplates/tpl-1',
    method: 'PUT',
    body: JSON.stringify({ id: 'tpl-1', name: 'Updated PPI' }),
  }, {
    path: '/entities/shopsettings/profile',
    method: 'PUT',
    body: JSON.stringify({ id: 'profile', shopName: 'Lee Auto' }),
  }];
  assert.deepEqual(
    applyQueuedEntityMutations('inspectiontemplates', [{ id: 'tpl-1', name: 'Old' }], queue),
    [{ id: 'tpl-1', name: 'Updated PPI' }],
  );
  assert.deepEqual(
    applyQueuedEntityMutations('shopsettings', [{ id: 'profile', shopName: 'Old' }], queue),
    [{ id: 'profile', shopName: 'Lee Auto' }],
  );
});

test('id-less local sample rows survive an empty remote list', () => {
  const samples = [{ name: 'Demo Customer' }];
  assert.deepEqual(applyQueuedEntityMutations('customers', samples, []), samples);
});
