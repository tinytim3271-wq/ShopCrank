import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueuedEntityMutations, persistMutationQueue, queuePendingEntityMutation } from './entity-persistence.js';

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

test('queued archives remain in remote-list overlays while hard deletes are removed', () => {
  const archived = { id: 'INV-1', number: 'INV-1', total: 100, archivedAt: '2026-11-04T00:00:00.000Z' };
  assert.deepEqual(
    applyQueuedEntityMutations('invoices', [{ id: 'INV-1', number: 'INV-1', total: 125 }], [{
      path: '/entities/invoices/INV-1',
      method: 'DELETE',
      body: JSON.stringify(archived),
    }]),
    [{ ...archived, total: 125 }],
  );
  assert.deepEqual(
    applyQueuedEntityMutations('invoices', [{ id: 'INV-1', number: 'INV-1' }], [{
      path: '/entities/invoices/INV-1',
      method: 'DELETE',
    }]),
    [],
  );
});

test('queued archives preserve a pending create before applying the archive', () => {
  const pending = [{
    key: '/entities/invoices/INV-1',
    method: 'POST',
    path: '/entities/invoices',
    body: JSON.stringify({ id: 'INV-1', number: 'INV-1' }),
  }];
  const result = queuePendingEntityMutation(pending, {
    key: '/entities/invoices/INV-1',
    method: 'DELETE',
    path: '/entities/invoices/INV-1',
    queueBody: JSON.stringify({ id: 'INV-1', number: 'INV-1', archivedAt: '2026-11-04T00:00:00.000Z' }),
  }, { id: 'mutation-1', queuedAt: 'now' });
  assert.deepEqual(result.map(item => item.method), ['POST', 'DELETE']);
  assert.deepEqual(
    applyQueuedEntityMutations('invoices', [], result),
    [{ id: 'INV-1', number: 'INV-1', archivedAt: '2026-11-04T00:00:00.000Z' }],
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
