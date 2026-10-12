import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettledShopEntityResults, readableShopEntityTypes } from './shop-entity-load.js';

test('readableShopEntityTypes filters role-restricted collections', () => {
  const collections = { vehicles: 'vehicles', keyprogrammingjobs: 'keyJobs' };
  const readRoles = { keyprogrammingjobs: ['admin', 'technician', 'service_writer'] };

  assert.deepEqual(readableShopEntityTypes(collections, readRoles, 'office'), ['vehicles']);
  assert.deepEqual(readableShopEntityTypes(collections, readRoles, 'technician'), ['vehicles', 'keyprogrammingjobs']);
});

test('applySettledShopEntityResults applies fulfilled arrays and reports rejected reads', () => {
  const applied = [];
  const rejected = [];
  const failure = new Error('denied');
  const failed = applySettledShopEntityResults(
    ['vehicles', 'inventory', 'vendors'],
    [
      { status: 'fulfilled', value: [{ id: 'vehicle-1' }] },
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: { records: [] } },
    ],
    (type, records) => applied.push([type, records]),
    (type, reason) => rejected.push([type, reason]),
  );

  assert.equal(failed, 1);
  assert.deepEqual(applied, [['vehicles', [{ id: 'vehicle-1' }]]]);
  assert.deepEqual(rejected, [['inventory', failure]]);
});
