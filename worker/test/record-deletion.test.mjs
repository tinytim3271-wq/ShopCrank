import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';

const shopId = 'shop-del';
const stamp = '2026-10-31T08:00:00.000Z';
const people = {
  owner: 'owner@shop.test',
  admin: 'admin@shop.test',
  writer: 'writer@shop.test',
  office: 'office@shop.test',
  tech: 'tech@shop.test',
};

async function setup() {
  const DB = createD1();
  // Shop owners are stored as `admin`; the PWA aliases `owner` to it.
  const roles = { owner: 'admin', admin: 'admin', writer: 'service_writer', office: 'office', tech: 'technician' };
  for (const [key, role] of Object.entries(roles)) {
    await DB.prepare('INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(people[key], shopId, role, key, stamp, stamp).run();
  }
  const seed = async (type, id, record) => DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(shopId, type, id, JSON.stringify({ id, ...record }), 'seed', stamp, stamp).run();
  const env = { DB, DEV_AUTH_BYPASS: '1' };
  const call = (who, method, path, body) => worker.fetch(new Request(`https://app.example.test/api/entities/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': people[who] },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const stored = async (type, id) => {
    const row = await DB.prepare('SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?').bind(shopId, type, id).first();
    return row ? JSON.parse(row.data_json) : null;
  };
  return { DB, seed, call, stored };
}

test('only owners and admins can delete records', async () => {
  const { seed, call, stored } = await setup();
  await seed('orders', 'RO-1', { customer: 'Pat', status: 'estimate' });
  for (const who of ['writer', 'office', 'tech']) {
    const response = await call(who, 'DELETE', 'orders/RO-1');
    assert.equal(response.status, 403, `${who} must not delete`);
  }
  assert.ok(await stored('orders', 'RO-1'));
  assert.equal((await call('owner', 'DELETE', 'orders/RO-1')).status, 204);
  assert.equal(await stored('orders', 'RO-1'), null);
  await seed('orders', 'RO-2', { customer: 'Pat', status: 'estimate' });
  assert.equal((await call('admin', 'DELETE', 'orders/RO-2')).status, 204);
});

test('invoices are archived with their payments kept', async () => {
  const { seed, call, stored } = await setup();
  await seed('invoices', 'INV-1', { number: 'INV-1', customer: 'Pat', amount: 100, ro: 'RO-1' });
  await seed('payments', 'pay-1', { invoiceNumber: 'INV-1', amount: 100, customer: 'Pat' });
  const response = await call('admin', 'DELETE', 'invoices/INV-1');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.archived, true);
  assert.equal(payload.record.archivedBy, people.admin);
  const invoice = await stored('invoices', 'INV-1');
  assert.ok(invoice.archivedAt);
  assert.match(invoice.archiveReasons.join(' '), /financial record/);
  assert.ok(await stored('payments', 'pay-1'), 'payment history must survive');
});

test('work orders with an invoice are archived; customers with history are archived; vehicles still block', async () => {
  const { seed, call, stored } = await setup();
  await seed('orders', 'RO-7', { customer: 'Lee', status: 'completed' });
  await seed('invoices', 'INV-7', { number: 'INV-7', customer: 'Lee', ro: 'RO-7', amount: 50 });
  const order = await call('owner', 'DELETE', 'orders/RO-7');
  assert.equal(order.status, 200);
  assert.deepEqual((await order.json()).reasons, ['linked to 1 invoice']);
  assert.ok((await stored('orders', 'RO-7')).archivedAt);

  await seed('customers', 'Lee', { name: 'Lee' });
  const customer = await call('owner', 'DELETE', 'customers/Lee');
  assert.equal(customer.status, 200);
  assert.ok((await stored('customers', 'Lee')).archivedAt);

  await seed('customers', 'Sam', { name: 'Sam' });
  await seed('vehicles', 'veh-1', { customer: 'Sam', vin: '1HGCM82633A004352' });
  const blocked = await call('owner', 'DELETE', 'customers/Sam');
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).message, /1 vehicle/);
  assert.ok(await stored('customers', 'Sam'));
});

test('signed estimates archive; plain estimates delete', async () => {
  const { seed, call, stored } = await setup();
  await seed('estimates', 'EST-1', { customer: 'Pat', status: 'approved', signatureKey: 'shops/shop-del/signatures/a.png' });
  await seed('estimates', 'EST-2', { customer: 'Pat', status: 'draft' });
  assert.equal((await call('admin', 'DELETE', 'estimates/EST-1')).status, 200);
  assert.ok((await stored('estimates', 'EST-1')).archivedAt);
  assert.equal((await call('admin', 'DELETE', 'estimates/EST-2')).status, 204);
  assert.equal(await stored('estimates', 'EST-2'), null);
});

test('employees with payroll are archived and lose access', async () => {
  const { DB, seed, call, stored } = await setup();
  await seed('employees', 'emp-tech', { email: people.tech, name: 'Tech', active: true, role: 'technician' });
  await seed('payrollentries', 'pay-row', { employeeId: 'emp-tech', workOrderId: 'RO-9', amount: 80 });
  const response = await call('owner', 'DELETE', 'employees/emp-tech');
  assert.equal(response.status, 200);
  const employee = await stored('employees', 'emp-tech');
  assert.ok(employee.archivedAt);
  assert.equal(employee.active, false);
  assert.ok(await stored('payrollentries', 'pay-row'));
  const access = await DB.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(people.tech).first();
  assert.equal(access, null);
});

test('stale saves keep the archive flag; only owners/admins restore', async () => {
  const { seed, call, stored } = await setup();
  await seed('invoices', 'INV-3', { number: 'INV-3', customer: 'Pat', amount: 20 });
  assert.equal((await call('admin', 'DELETE', 'invoices/INV-3')).status, 200);
  const save = await call('writer', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', customer: 'Pat', amount: 25 });
  assert.equal(save.status, 200);
  assert.ok((await stored('invoices', 'INV-3')).archivedAt, 'a stale save must not un-archive');
  assert.equal((await call('writer', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', archivedAt: null })).status, 403);
  assert.equal((await call('owner', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', customer: 'Pat', amount: 25, archivedAt: null })).status, 200);
  assert.equal((await stored('invoices', 'INV-3')).archivedAt, null);
});

test('chat housekeeping keeps its membership rule', async () => {
  const { seed, call, stored } = await setup();
  await seed('conversations', 'conv-1', { kind: 'direct', memberEmails: [people.tech, people.writer] });
  await seed('chatmessages', 'msg-1', { conversationId: 'conv-1', body: 'hi', memberEmails: [people.tech, people.writer] });
  assert.equal((await call('owner', 'DELETE', 'chatmessages/msg-1')).status, 403, 'non-member cannot remove a message');
  assert.ok(await stored('chatmessages', 'msg-1'));
});
