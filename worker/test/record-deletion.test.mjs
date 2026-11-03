import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEntities } from '../src/routes/entities.mjs';
import { HttpError } from '../src/http.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';

function seed(DB, shopId, type, id, data) {
  return DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(shopId, type, id, JSON.stringify({ id, ...data }), 'seed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z').run();
}

async function ids(DB, shopId, type) {
  const result = await DB.prepare('SELECT entity_id FROM entities WHERE shop_id = ? AND entity_type = ? ORDER BY entity_id').bind(shopId, type).all();
  return result.results.map(row => row.entity_id);
}

function context(role) {
  return { shopId: 'shop-1', role, email: `${role}@shop.test`, userId: `user-${role}` };
}

function remove(env, role, type, id, query = '') {
  const request = new Request(`https://shopcrank.test/api/entities/${type}/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  return handleEntities(request, env, context(role), ['entities', type, encodeURIComponent(id)]);
}

async function shopWithHistory() {
  const DB = createD1();
  await seed(DB, 'shop-1', 'customers', 'c1', { name: 'Dana Ruiz' });
  await seed(DB, 'shop-1', 'customers', 'c2', { name: 'Lone Customer' });
  await seed(DB, 'shop-1', 'customers', 'c3', { name: 'Other Customer' });
  await seed(DB, 'shop-1', 'vehicles', 'v1', { customer: 'Dana Ruiz', vin: '1HGCM82633A004352' });
  await seed(DB, 'shop-1', 'vehicles', 'v3', { customer: 'Other Customer' });
  await seed(DB, 'shop-1', 'orders', 'RO-1', { customer: 'Dana Ruiz', vehicleId: 'v1' });
  await seed(DB, 'shop-1', 'orders', 'RO-3', { customer: 'Other Customer' });
  await seed(DB, 'shop-1', 'invoices', 'INV-1', { number: 'INV-1', customer: 'Dana Ruiz' });
  await seed(DB, 'shop-1', 'payments', 'pay-1', { invoiceNumber: 'INV-1' });
  await seed(DB, 'shop-1', 'payments', 'pay-3', { invoiceNumber: 'INV-3', customer: 'Other Customer' });
  await seed(DB, 'shop-1', 'estimates', 'EST-1', { customer: 'Dana Ruiz' });
  await seed(DB, 'shop-1', 'appointments', 'appt-1', { customer: 'Dana Ruiz' });
  await seed(DB, 'shop-2', 'vehicles', 'v1-other-shop', { customer: 'Dana Ruiz' });
  return { DB };
}

for (const role of ['office', 'service_writer', 'technician']) {
  test(`${role} cannot delete customers, vehicles, work orders, invoices or payments`, async () => {
    const env = await shopWithHistory();
    for (const [type, id] of [['customers', 'c2'], ['vehicles', 'v3'], ['orders', 'RO-3'], ['invoices', 'INV-1'], ['payments', 'pay-3']]) {
      await assert.rejects(remove(env, role, type, id), error => error instanceof HttpError && error.status === 403, `${role} ${type}`);
    }
    assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c2', 'c3']);
    assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), ['INV-1']);
  });
}

test('admin deletes a vehicle, a work order, and an invoice with its payments', async () => {
  const env = await shopWithHistory();
  assert.equal((await remove(env, 'admin', 'vehicles', 'v3')).status, 204);
  assert.equal((await remove(env, 'owner', 'orders', 'RO-3')).status, 204);
  assert.equal((await remove(env, 'admin', 'invoices', 'INV-1')).status, 204);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v1']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'orders'), ['RO-1']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), []);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'payments'), ['pay-3']);
});

test('admin deletes a customer with no history', async () => {
  const env = await shopWithHistory();
  assert.equal((await remove(env, 'admin', 'customers', 'c2')).status, 204);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c3']);
});

test('deleting a customer with history needs cascade and names what is linked', async () => {
  const env = await shopWithHistory();
  await assert.rejects(remove(env, 'admin', 'customers', 'c1'), error => error instanceof HttpError
    && error.status === 409
    && /1 vehicle, 1 work order, 1 invoice, 1 estimate, 1 payment and 1 appointment/.test(error.message));
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c2', 'c3']);
});

test('cascade deletes the customer and only their linked records, in this shop only', async () => {
  const env = await shopWithHistory();
  assert.equal((await remove(env, 'admin', 'customers', 'c1', '?cascade=1')).status, 204);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c2', 'c3']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v3']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'orders'), ['RO-3']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), []);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'payments'), ['pay-3']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'estimates'), []);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'appointments'), []);
  assert.deepEqual(await ids(env.DB, 'shop-2', 'vehicles'), ['v1-other-shop']);
});

test('cascade is still admin-only', async () => {
  const env = await shopWithHistory();
  await assert.rejects(remove(env, 'office', 'customers', 'c1', '?cascade=1'), error => error.status === 403);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v1', 'v3']);
});

test('other record types keep their existing delete rules', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'inventory', 'part-1', { name: 'Oil filter' });
  assert.equal((await remove(env, 'technician', 'inventory', 'part-1')).status, 204);
});
