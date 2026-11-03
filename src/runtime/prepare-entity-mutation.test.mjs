import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEntityMutation, withOptimisticConcurrencyHeaders } from './prepare-entity-mutation.js';
let seq = 0;
function mutationId() {
  seq += 1;
  return `mut-${seq}`;
}

test('POST without a body does not throw and is not queued', () => {
  assert.doesNotThrow(() => prepareEntityMutation('/entities/orders', { method: 'POST' }, mutationId));
  const result = prepareEntityMutation('/entities/orders', { method: 'POST' }, mutationId);
  assert.equal(result.queueable, false);
  assert.match(result.key, /^\/entities\/orders\//);
});

test('POST with a body assigns an id and stays queueable', () => {
  const result = prepareEntityMutation('/entities/orders', {
    method: 'POST',
    body: JSON.stringify({ customer: 'Ada' }),
  }, mutationId);
  assert.equal(result.queueable, true);
  const parsed = JSON.parse(result.options.body);
  assert.ok(parsed.id);
  assert.equal(result.key, `/entities/orders/${parsed.id}`);
});

test('DELETE without a body remains queueable', () => {
  const result = prepareEntityMutation('/entities/orders/RO-1', { method: 'DELETE' }, mutationId);
  assert.equal(result.queueable, true);
  assert.equal(result.key, '/entities/orders/RO-1');
});

test('blocked payroll entities are never queued', () => {
  const result = prepareEntityMutation('/entities/payrollentries', {
    method: 'POST',
    body: JSON.stringify({ hours: 1 }),
  }, mutationId);
  assert.equal(result.queueable, false);
});

test('PUT captures updatedAt as expectedUpdatedAt for If-Match', () => {
  const updatedAt = '2026-10-06T12:00:00.000Z';
  const result = prepareEntityMutation('/entities/orders/RO-1', {
    method: 'PUT',
    body: JSON.stringify({ id: 'RO-1', updatedAt, status: 'estimate' }),
  }, mutationId);
  assert.equal(result.expectedUpdatedAt, updatedAt);
  assert.equal(result.queueable, true);
});

test('withOptimisticConcurrencyHeaders attaches If-Match for online and offline PUTs', () => {
  const stamped = withOptimisticConcurrencyHeaders(
    { method: 'PUT', body: '{"id":"RO-1"}', headers: { 'X-Extra': '1' } },
    '2026-10-06T12:00:00.000Z',
  );
  assert.equal(stamped.headers['If-Match'], '2026-10-06T12:00:00.000Z');
  assert.equal(stamped.headers['X-Extra'], '1');
  assert.deepEqual(
    withOptimisticConcurrencyHeaders({ method: 'PUT' }, null),
    { method: 'PUT' },
  );
});

test('customer cascade deletes are never queued for later replay', () => {
  const plain = prepareEntityMutation('/entities/customers/c1', { method: 'DELETE' });
  const cascade = prepareEntityMutation('/entities/customers/c1?cascade=1', { method: 'DELETE' });
  assert.equal(plain.queueable, true);
  assert.equal(cascade.queueable, false);
});
