import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettledShopEntityResults, readableShopEntityTypes } from './shop-entity-load.js';

const COLLECTIONS = {
  vehicles: 'vehicles',
  inventory: 'inventory',
  keyprogrammingjobs: 'keyJobs',
  diagnosticsessions: 'diagnosticSessions',
};

const READ_ROLES = {
  keyprogrammingjobs: ['admin', 'technician', 'service_writer'],
};

test('office role skips keyprogrammingjobs so the batch is not 403ed', () => {
  const types = readableShopEntityTypes(COLLECTIONS, READ_ROLES, 'office');
  assert.deepEqual(types, ['vehicles', 'inventory', 'diagnosticsessions']);
  assert.ok(!types.includes('keyprogrammingjobs'));
});

test('technician role still loads keyprogrammingjobs', () => {
  const types = readableShopEntityTypes(Object.keys(COLLECTIONS), READ_ROLES, 'technician');
  assert.ok(types.includes('keyprogrammingjobs'));
  assert.equal(types.length, 4);
});

test('settled results apply fulfilled types and keep going after a rejection', () => {
  const applied = [];
  const rejected = [];
  const failed = applySettledShopEntityResults(
    ['vehicles', 'keyprogrammingjobs', 'inventory'],
    [
      { status: 'fulfilled', value: [{ id: 'v1' }] },
      { status: 'rejected', reason: new Error('Role office cannot read keyprogrammingjobs') },
      { status: 'fulfilled', value: [{ id: 'i1' }] },
    ],
    (type, records) => applied.push([type, records]),
    (type, reason) => rejected.push([type, String(reason.message || reason)]),
  );
  assert.equal(failed, 1);
  assert.deepEqual(applied, [
    ['vehicles', [{ id: 'v1' }]],
    ['inventory', [{ id: 'i1' }]],
  ]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0][0], 'keyprogrammingjobs');
});

test('non-array fulfilled payloads are ignored (do not wipe local collections)', () => {
  const applied = [];
  const failed = applySettledShopEntityResults(
    ['vehicles'],
    [{ status: 'fulfilled', value: { queued: true } }],
    (type, records) => applied.push([type, records]),
  );
  assert.equal(failed, 0);
  assert.deepEqual(applied, []);
});
