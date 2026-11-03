import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';

const ORIGIN = 'https://shopcrank.test';

function seed(DB, shopId, type, id, data) {
  return DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(shopId, type, id, JSON.stringify({ id, ...data }), 'seed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z').run();
}

async function ids(DB, shopId, type) {
  const result = await DB.prepare('SELECT entity_id FROM entities WHERE shop_id = ? AND entity_type = ? ORDER BY entity_id').bind(shopId, type).all();
  return result.results.map(row => row.entity_id);
}

function remove(env, role, type, id, query = '') {
  return worker.fetch(new Request(`${ORIGIN}/api/entities/${type}/${encodeURIComponent(id)}${query}`, {
    method: 'DELETE',
    headers: { 'X-ShopCrank-Dev-Email': `${role}@shop.test` },
  }), env);
}

async function shopWithHistory() {
  const DB = createD1();
  for (const role of ['admin', 'office', 'service_writer', 'technician']) {
    await DB.prepare('INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`${role}@shop.test`, 'shop-1', role, role, 'now', 'now').run();
  }
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
  return { DB, DEV_AUTH_BYPASS: '1' };
}

for (const role of ['office', 'service_writer', 'technician']) {
  test(`${role} cannot delete customers, vehicles, work orders, invoices or payments`, async () => {
    const env = await shopWithHistory();
    for (const [type, id] of [['customers', 'c2'], ['vehicles', 'v3'], ['orders', 'RO-3'], ['invoices', 'INV-1'], ['payments', 'pay-3']]) {
      assert.equal((await remove(env, role, type, id)).status, 403, `${role} ${type}`);
    }
    assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c2', 'c3']);
    assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), ['INV-1']);
  });
}

function call(env, role, method, path, body) {
  return worker.fetch(new Request(`${ORIGIN}/api/entities/${path}`, {
    method,
    headers: { 'X-ShopCrank-Dev-Email': `${role}@shop.test`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function stored(DB, type, id) {
  const row = await DB.prepare("SELECT data_json FROM entities WHERE shop_id = 'shop-1' AND entity_type = ? AND entity_id = ?").bind(type, id).first();
  return row ? JSON.parse(row.data_json) : null;
}

test('records with no money attached are permanently deleted', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'invoices', 'INV-9', { number: 'INV-9', customer: 'Other Customer', status: 'sent' });
  assert.equal((await remove(env, 'admin', 'vehicles', 'v3')).status, 204);
  assert.equal((await remove(env, 'admin', 'orders', 'RO-3')).status, 204);
  assert.equal((await remove(env, 'admin', 'invoices', 'INV-9')).status, 204, 'an invoice never paid, signed or sent by link is a draft');
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v1']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'orders'), ['RO-1']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), ['INV-1']);
});

test('an invoice with a payment is archived with its payments, not deleted', async () => {
  const env = await shopWithHistory();
  const response = await remove(env, 'admin', 'invoices', 'INV-1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.action, 'archive');
  assert.deepEqual(body.archived, { invoices: ['INV-1'], payments: ['pay-1'] });
  assert.deepEqual(await ids(env.DB, 'shop-1', 'invoices'), ['INV-1'], 'the row stays for tax reports');
  const invoice = await stored(env.DB, 'invoices', 'INV-1');
  assert.ok(invoice.archivedAt);
  assert.equal(invoice.archivedBy, 'admin@shop.test');
  assert.ok((await stored(env.DB, 'payments', 'pay-1')).archivedAt);
});

test('an invoice sent to the customer by link is archived even without a payment', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'invoices', 'INV-8', { number: 'INV-8', customer: 'Other Customer', status: 'sent' });
  await env.DB.prepare("INSERT INTO customer_document_links (id, token_hash, shop_id, document_type, document_id, expires_at, created_at, created_by) VALUES ('l1', 'h1', 'shop-1', 'invoice', 'INV-8', '2030-01-01', 'now', 'admin')").run();
  const response = await remove(env, 'admin', 'invoices', 'INV-8');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).action, 'archive');
});

test('a work order or vehicle tied to an invoice is archived', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'invoices', 'INV-3', { number: 'INV-3', ro: 'RO-3', customer: 'Other Customer' });
  await seed(env.DB, 'shop-1', 'orders', 'RO-4', { customer: 'Other Customer', vehicleId: 'v3' });
  await seed(env.DB, 'shop-1', 'invoices', 'INV-4', { number: 'INV-4', ro: 'RO-4', customer: 'Other Customer' });
  assert.equal((await (await remove(env, 'admin', 'orders', 'RO-3')).json()).action, 'archive');
  assert.equal((await (await remove(env, 'admin', 'vehicles', 'v3')).json()).action, 'archive');
});

test('admin deletes a customer with no history', async () => {
  const env = await shopWithHistory();
  assert.equal((await remove(env, 'admin', 'customers', 'c2')).status, 204);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c3']);
});

test('deleting a customer with history needs cascade and names what is linked', async () => {
  const env = await shopWithHistory();
  const response = await remove(env, 'admin', 'customers', 'c1');
  assert.equal(response.status, 409);
  assert.match(await response.text(), /1 vehicle, 1 work order, 1 invoice, 1 estimate, 1 payment and 1 appointment/);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c2', 'c3']);
});

test('a customer with invoices is archived with their vehicles and work orders; money records stay', async () => {
  const env = await shopWithHistory();
  const response = await remove(env, 'admin', 'customers', 'c1', '?cascade=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.action, 'archive');
  assert.deepEqual(body.archived, { customers: ['c1'], vehicles: ['v1'], orders: ['RO-1'] });
  assert.deepEqual(body.deleted, { appointments: ['appt-1'] });
  for (const [type, id] of [['customers', 'c1'], ['vehicles', 'v1'], ['orders', 'RO-1']]) assert.ok((await stored(env.DB, type, id)).archivedAt, `${type} archived`);
  assert.equal((await stored(env.DB, 'invoices', 'INV-1')).archivedAt, undefined, 'invoices stay as they are');
  assert.deepEqual(await ids(env.DB, 'shop-1', 'estimates'), ['EST-1']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'appointments'), []);
  assert.deepEqual(await ids(env.DB, 'shop-2', 'vehicles'), ['v1-other-shop']);
});

test('a customer with only non-financial history is deleted with it, in this shop only', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'customers', 'c4', { name: 'No Money' });
  await seed(env.DB, 'shop-1', 'vehicles', 'v4', { customer: 'No Money' });
  await seed(env.DB, 'shop-1', 'orders', 'RO-5', { customer: 'No Money' });
  assert.equal((await remove(env, 'admin', 'customers', 'c4', '?cascade=1')).status, 204);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'customers'), ['c1', 'c2', 'c3']);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v1', 'v3']);
});

test('archived records are hidden from lists and listed on request for admins only', async () => {
  const env = await shopWithHistory();
  await remove(env, 'admin', 'invoices', 'INV-1');
  const active = await (await call(env, 'admin', 'GET', 'invoices')).json();
  assert.deepEqual(active.map(row => row.id), []);
  const archived = await (await call(env, 'admin', 'GET', 'invoices?archived=only')).json();
  assert.deepEqual(archived.map(row => row.id), ['INV-1']);
  assert.equal((await call(env, 'office', 'GET', 'invoices?archived=only')).status, 403);
  const payments = await (await call(env, 'office', 'GET', 'payments')).json();
  assert.deepEqual(payments.map(row => row.id), ['pay-3']);
});

test('creating over an archived record is refused instead of overwriting it', async () => {
  const env = await shopWithHistory();
  await remove(env, 'admin', 'customers', 'c1', '?cascade=1');
  const response = await call(env, 'admin', 'POST', 'orders', { id: 'RO-1', customer: 'New Person', vehicle: 'Car', complaint: 'Noise' });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /archived/);
  assert.equal((await stored(env.DB, 'orders', 'RO-1')).customer, 'Dana Ruiz');
});

test('a stale edit keeps the archive; restore brings back everything archived together', async () => {
  const env = await shopWithHistory();
  await remove(env, 'admin', 'customers', 'c1', '?cascade=1');
  const stale = await call(env, 'service_writer', 'PUT', 'orders/RO-1', { customer: 'Dana Ruiz', vehicleId: 'v1', notes: 'edited offline' });
  assert.equal(stale.status, 200);
  assert.ok((await stored(env.DB, 'orders', 'RO-1')).archivedAt, 'still archived after a stale save');
  assert.equal((await call(env, 'office', 'POST', 'customers/c1/restore')).status, 403);
  const restored = await (await call(env, 'admin', 'POST', 'customers/c1/restore')).json();
  assert.deepEqual(restored.restored, { customers: ['c1'], vehicles: ['v1'], orders: ['RO-1'] });
  for (const [type, id] of [['customers', 'c1'], ['vehicles', 'v1'], ['orders', 'RO-1']]) assert.equal((await stored(env.DB, type, id)).archivedAt, undefined);
  assert.equal((await stored(env.DB, 'orders', 'RO-1')).notes, 'edited offline');
});

test('cascade is still admin-only', async () => {
  const env = await shopWithHistory();
  assert.equal((await remove(env, 'office', 'customers', 'c1', '?cascade=1')).status, 403);
  assert.deepEqual(await ids(env.DB, 'shop-1', 'vehicles'), ['v1', 'v3']);
});

test('other record types keep their existing delete rules', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'inventory', 'part-1', { name: 'Oil filter' });
  assert.equal((await remove(env, 'technician', 'inventory', 'part-1')).status, 204);
});

test('a service writer records a refused service: the job card is archived with the refusal and an admin can restore it', async () => {
  const env = await shopWithHistory();
  assert.equal((await call(env, 'technician', 'POST', 'orders/RO-3/refuse', {})).status, 403);
  const refused = await call(env, 'service_writer', 'POST', 'orders/RO-3/refuse', { customerName: 'Other Customer', note: 'Declined over the phone' });
  assert.equal(refused.status, 200);
  const body = await refused.json();
  assert.equal(body.action, 'archive');
  assert.deepEqual(body.archived, { orders: ['RO-3'] });
  const listed = await (await call(env, 'admin', 'GET', 'orders')).json();
  assert.ok(!(Array.isArray(listed) ? listed : listed.records).some(order => order.id === 'RO-3'));
  const archived = await (await call(env, 'admin', 'GET', 'orders?archived=only')).json();
  const order = (Array.isArray(archived) ? archived : archived.records).find(item => item.id === 'RO-3');
  assert.equal(order.archiveReason, 'Customer refused service');
  assert.equal(order.serviceRefusal.note, 'Declined over the phone');
  assert.equal((await call(env, 'service_writer', 'POST', 'orders/RO-3/refuse', {})).status, 409);
  assert.equal((await call(env, 'admin', 'POST', 'orders/RO-3/restore')).status, 200);
  const back = await (await call(env, 'admin', 'GET', 'orders/RO-3')).json();
  assert.ok(!back.archivedAt);
});

test('a save cannot set or change archive fields', async () => {
  const env = await shopWithHistory();
  const put = await call(env, 'service_writer', 'PUT', 'orders/RO-3', { id: 'RO-3', customer: 'Other Customer', archivedAt: '2026-11-01T00:00:00Z', archiveReason: 'sneaky' });
  assert.ok(put.status < 300, String(put.status));
  const listed = await (await call(env, 'admin', 'GET', 'orders')).json();
  assert.ok((Array.isArray(listed) ? listed : listed.records).some(order => order.id === 'RO-3'), 'order must stay visible');
});

test('an invoice whose work order has a deposit is archived, deposit included', async () => {
  const env = await shopWithHistory();
  await seed(env.DB, 'shop-1', 'invoices', 'INV-9', { number: 'INV-9', customer: 'Other Customer', ro: 'RO-3', status: 'sent' });
  await seed(env.DB, 'shop-1', 'payments', 'dep-9', { workOrderId: 'RO-3', amount: 50, kind: 'deposit' });
  const response = await remove(env, 'admin', 'invoices', 'INV-9');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.action, 'archive');
  assert.deepEqual(body.archived.payments, ['dep-9']);
  const invoices = await (await call(env, 'office', 'GET', 'invoices?archived=include')).json();
  assert.ok((Array.isArray(invoices) ? invoices : invoices.records).some(item => item.id === 'INV-9' && item.archivedAt), 'readers can load archived invoices for accounting');
});
