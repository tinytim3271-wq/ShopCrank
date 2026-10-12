import assert from 'node:assert/strict';
import test from 'node:test';
import { createMutationQueueStore } from './mutation-queue-store.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('mutation queue survives a fresh store instance (reload)', () => {
  const storage = memoryStorage();
  const first = createMutationQueueStore({ storage });
  const item = {
    id: 'm1',
    key: '/entities/orders/RO-1',
    path: '/entities/orders/RO-1',
    method: 'PUT',
    body: JSON.stringify({ id: 'RO-1', customer: 'Acme', total: 684.22, taxRate: 8.25 }),
    expectedUpdatedAt: '2026-09-30T00:00:00.000Z',
    queuedAt: '2026-09-30T12:00:00.000Z',
    conflict: false,
  };

  first.write([item]);

  const reloaded = createMutationQueueStore({ storage });
  const queue = reloaded.read();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].body, item.body);
  assert.match(queue[0].body, /"total":684\.22/);
  assert.match(queue[0].body, /"taxRate":8\.25/);
});

test('write replaces prior queue and empty write clears durable storage', () => {
  const storage = memoryStorage();
  const store = createMutationQueueStore({ storage, storeKey: 'q' });
  store.write([{ id: 'a', method: 'DELETE', path: '/entities/orders/RO-9', key: '/entities/orders/RO-9' }]);
  store.write([]);
  assert.equal(storage.getItem('q'), '[]');
  assert.deepEqual(store.read(), []);
});

test('corrupt storage yields an empty queue instead of throwing', () => {
  const storage = memoryStorage();
  storage.setItem('mechpro-mutation-queue-v1', '{not-json');
  const store = createMutationQueueStore({ storage });
  assert.deepEqual(store.read(), []);
});
