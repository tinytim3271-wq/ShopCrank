import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { putEntity as deployedPutEntity } from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { handleEntities, putEntity as modularPutEntity, removeEntity } from '../src/routes/entities.mjs';
import { HttpError } from '../src/http.mjs';

const shopId = 'shop-del';
const stamp = '2026-10-31T08:00:00.000Z';
const people = {
  owner: 'owner@shop.test',
  admin: 'admin@shop.test',
  writer: 'writer@shop.test',
  office: 'office@shop.test',
  tech: 'tech@shop.test',
};

async function setup(modular = false) {
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
  const call = async (who, method, path, body, extraHeaders = {}) => {
    const request = new Request(`https://app.example.test/api/entities/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': people[who], ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!modular) return worker.fetch(request, env);
    try {
      return await handleEntities(request, env, {
        shopId, userId: 'test-user', email: people[who], role: roles[who],
      }, ['entities', ...path.split('/')]);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return Response.json({ message: error.message }, { status: error.status });
    }
  };
  const stored = async (type, id) => {
    const row = await DB.prepare('SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ? AND entity_id = ?').bind(shopId, type, id).first();
    return row ? JSON.parse(row.data_json) : null;
  };
  return { DB, seed, call, stored, env };
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

test('a financial link added during delete planning causes archival instead of deletion', async () => {
  const { DB, seed, stored } = await setup();
  await seed('estimates', 'EST-RACE', { status: 'draft' });
  let inserted = false;
  const raceDB = {
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sql.includes('SELECT COUNT(*) AS found FROM entities')) return statement;
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          return {
            first: async () => {
              const row = await bound.first();
              if (!inserted) {
                DB.sqlite.prepare(`
                  INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
                  VALUES (?, 'payments', 'pay-race', ?, 'seed', ?, ?)
                `).run(shopId, JSON.stringify({ id: 'pay-race', estimateId: 'EST-RACE', amount: 10 }), stamp, stamp);
                inserted = true;
              }
              return row;
            },
          };
        },
      };
    },
    batch: statements => DB.batch(statements),
  };
  const result = await removeEntity(
    { DB: raceDB },
    { shopId, email: people.admin, userId: 'admin-user', role: 'admin' },
    'estimates',
    'EST-RACE',
  );
  assert.equal(result.action, 'archive');
  assert.match((await stored('estimates', 'EST-RACE')).archiveReasons.join(' '), /payment/);
  assert.ok(await stored('payments', 'pay-race'));
});

test('employee archive and Access removal roll back together; retry revokes already-archived access', async () => {
  const { DB, seed, call, stored } = await setup();
  await seed('employees', 'emp-atomic', { email: people.tech, active: true, role: 'technician' });
  await seed('payrollentries', 'pay-atomic', { employeeId: 'emp-atomic' });
  await DB.prepare('UPDATE users SET id = ? WHERE email = ?').bind('user-atomic', people.tech).run();
  const user = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(people.tech).first();
  await DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('session-atomic', user.id, 'hash-atomic', '2027-01-01T00:00:00.000Z', stamp).run();
  DB.sqlite.exec(`
    CREATE TRIGGER fail_employee_access_delete BEFORE DELETE ON users
    WHEN lower(old.email) = '${people.tech}'
    BEGIN SELECT RAISE(ABORT, 'simulated Access deletion failure'); END
  `);
  assert.equal((await call('owner', 'DELETE', 'employees/emp-atomic')).status, 500);
  assert.equal((await stored('employees', 'emp-atomic')).archivedAt, undefined);
  assert.equal((await DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?').bind('session-atomic').first()).revoked_at, null);
  DB.sqlite.exec('DROP TRIGGER fail_employee_access_delete');

  await DB.prepare(`UPDATE entities SET data_json = json_set(data_json, '$.archivedAt', ?, '$.active', 0)
    WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?`).bind(stamp, shopId, 'emp-atomic').run();
  const response = await call('owner', 'DELETE', 'employees/emp-atomic');
  assert.equal(response.status, 200);
  assert.equal(await DB.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(people.tech).first(), null);
  assert.ok((await DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?').bind('session-atomic').first()).revoked_at);
});

for (const [name, put] of [['deployed', deployedPutEntity], ['module', modularPutEntity]]) {
  test(`employee save and Access sync cannot race archive revocation (${name} putEntity)`, async () => {
    const { DB, seed, stored } = await setup();
    await seed('employees', 'emp-sync-race', { email: people.tech, active: true, role: 'technician' });
    await DB.prepare('UPDATE users SET id = ? WHERE email = ?').bind('user-sync-race', people.tech).run();
    await DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('session-sync-race', 'user-sync-race', 'hash-sync-race', '2027-01-01T00:00:00.000Z', stamp).run();
    let archived = false;
    const archiveEmployee = async () => {
      if (archived) return;
      archived = true;
      const archivedAt = '2026-10-31T08:01:00.000Z';
      await DB.batch([
        DB.prepare(`UPDATE entities SET data_json = json_set(data_json, '$.archivedAt', ?, '$.active', 0), updated_at = ?
          WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?`).bind(archivedAt, archivedAt, shopId, 'emp-sync-race'),
        DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(archivedAt, 'user-sync-race'),
        DB.prepare('DELETE FROM users WHERE email = ? COLLATE NOCASE AND shop_id = ?').bind(people.tech, shopId),
      ]);
    };
    const raceDB = {
      prepare(sql) {
        const statement = DB.prepare(sql);
        if (!sql.includes('UPDATE entities SET data_json = ?, updated_at = ?')) return statement;
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              runSync: () => bound.runSync(),
              run: async () => {
                const result = await bound.run();
                await archiveEmployee();
                return result;
              },
            };
          },
        };
      },
      batch: async statements => {
        const results = await DB.batch(statements);
        await archiveEmployee();
        return results;
      },
    };
    await put({ DB: raceDB }, { shopId, userId: 'admin-user', email: people.admin, role: 'admin' }, 'employees', 'emp-sync-race', {
      id: 'emp-sync-race', email: people.tech, active: true, role: 'technician',
    }, stamp);
    assert.ok((await stored('employees', 'emp-sync-race')).archivedAt);
    assert.equal((await stored('employees', 'emp-sync-race')).active, 0);
    assert.equal(await DB.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(people.tech).first(), null);
    assert.ok((await DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?').bind('session-sync-race').first()).revoked_at);
  });

  test(`stale saves cannot clear an archive or change employee Access (${name} putEntity)`, async () => {
    const { DB, seed, stored } = await setup();
    await seed('invoices', 'INV-CAS', { number: 'INV-CAS', amount: 50 });
    await seed('employees', 'emp-cas', { email: people.tech, active: true, role: 'technician' });
    await DB.prepare('UPDATE users SET enabled = 0 WHERE email = ?').bind(people.tech).run();
    let updateInvoice = true;
    let archiveEmployee = true;
    const raceDB = {
      prepare(sql) {
        const statement = DB.prepare(sql);
        if (!sql.includes('SELECT created_at, created_by, updated_at, data_json FROM entities')) return statement;
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              first: async () => {
                const row = await bound.first();
                if (values[1] === 'invoices' && updateInvoice) {
                  DB.sqlite.prepare(`UPDATE entities SET data_json = json_set(data_json, '$.archivedAt', ?), updated_at = ?
                    WHERE shop_id = ? AND entity_type = 'invoices' AND entity_id = ?`).run(stamp, '2026-10-31T08:01:00.000Z', shopId, 'INV-CAS');
                  updateInvoice = false;
                }
                if (values[1] === 'employees' && archiveEmployee) {
                  DB.sqlite.prepare(`UPDATE entities SET data_json = json_set(data_json, '$.archivedAt', ?, '$.active', 0), updated_at = ?
                    WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?`).run(stamp, '2026-10-31T08:01:00.000Z', shopId, 'emp-cas');
                  archiveEmployee = false;
                }
                return row;
              },
            };
          },
        };
      },
      batch: statements => DB.batch(statements),
    };
    const context = { shopId, userId: 'admin-user', email: people.admin, role: 'admin' };
    await assert.rejects(put({ DB: raceDB }, context, 'invoices', 'INV-CAS', {
      id: 'INV-CAS', number: 'INV-CAS', amount: 90,
    }, stamp), error => error.status === 409);
    await assert.rejects(put({ DB: raceDB }, context, 'employees', 'emp-cas', {
      id: 'emp-cas', email: people.tech, active: true, role: 'technician',
    }, stamp), error => error.status === 409);
    assert.ok((await stored('invoices', 'INV-CAS')).archivedAt);
    assert.ok((await stored('employees', 'emp-cas')).archivedAt);
    const access = await DB.prepare('SELECT enabled FROM users WHERE email = ?').bind(people.tech).first();
    assert.equal(access.enabled, 0);
  });
}

test('archive-only request header is permitted by CORS preflight', async () => {
  const { env } = await setup();
  const response = await worker.fetch(new Request('https://app.example.test/api/entities/customers/c1', {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example.test' },
  }), env);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-ShopCrank-Archive-Only/);
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

for (const modular of [false, true]) {
  test(`explicit archive intent cannot escalate to hard deletion (${modular ? 'module' : 'deployed'} handler)`, async () => {
    const { seed, call, stored } = await setup(modular);
    await seed('customers', 'No-history', { name: 'No history' });
    const response = await call('owner', 'DELETE', 'customers/No-history', null, { 'X-ShopCrank-Archive-Only': 'true' });
    assert.equal(response.status, 200);
    assert.ok((await stored('customers', 'No-history')).archivedAt);
  });
}

test('archiving preserves invoice changes made after the initial read', async () => {
  const { DB, seed, stored } = await setup();
  await seed('invoices', 'INV-RACE', { number: 'INV-RACE', customer: 'Pat', amount: 100 });
  let mutated = false;
  const raceDB = {
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sql.includes('SELECT data_json, updated_at FROM entities')) return statement;
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          return {
            first: async () => {
              const row = await bound.first();
              if (!mutated && values[1] === 'invoices' && values[2] === 'INV-RACE') {
                DB.sqlite.prepare(`
                  UPDATE entities SET data_json = json_set(data_json, '$.signatureKey', ?)
                  WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
                `).run('signed-during-archive', shopId, 'invoices', 'INV-RACE');
                mutated = true;
              }
              return row;
            },
          };
        },
      };
    },
    batch: statements => DB.batch(statements),
  };

  const result = await removeEntity(
    { DB: raceDB },
    { shopId, email: people.admin, userId: 'admin-user', role: 'admin' },
    'invoices',
    'INV-RACE',
  );
  assert.equal(result.action, 'archive');
  assert.equal((await stored('invoices', 'INV-RACE')).signatureKey, 'signed-during-archive');
  assert.equal(result.body.record.signatureKey, 'signed-during-archive');
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

  const staleSave = await call('owner', 'PUT', 'employees/emp-tech', {
    id: 'emp-tech',
    email: people.tech,
    name: 'Tech',
    active: true,
    role: 'technician',
  });
  assert.equal(staleSave.status, 200);
  const staleEmployee = await stored('employees', 'emp-tech');
  assert.ok(staleEmployee.archivedAt);
  assert.equal(staleEmployee.active, false);
  const disabledAccess = await DB.prepare('SELECT enabled FROM users WHERE email = ?').bind(people.tech).first();
  assert.equal(disabledAccess.enabled, 0);

  const restore = await call('owner', 'PUT', 'employees/emp-tech', {
    id: 'emp-tech',
    email: people.tech,
    name: 'Tech',
    active: true,
    role: 'technician',
    archivedAt: null,
  });
  assert.equal(restore.status, 200);
  const restoredEmployee = await stored('employees', 'emp-tech');
  assert.equal(restoredEmployee.archivedAt, null);
  assert.equal(restoredEmployee.active, true);
  const restoredAccess = await DB.prepare('SELECT enabled FROM users WHERE email = ?').bind(people.tech).first();
  assert.equal(restoredAccess.enabled, 1);
});

test('employee archive and Access removal roll back together', async () => {
  const { DB, seed, stored } = await setup();
  await seed('employees', 'emp-rollback', { email: people.tech, name: 'Tech', active: true, role: 'technician' });
  await seed('payrollentries', 'pay-rollback', { employeeId: 'emp-rollback', amount: 80 });
  DB.sqlite.exec(`
    CREATE TRIGGER reject_user_delete BEFORE DELETE ON users
    BEGIN SELECT RAISE(ABORT, 'revoke failed'); END;
  `);

  await assert.rejects(removeEntity(
    { DB },
    { shopId, email: people.admin, userId: 'admin-user', role: 'admin' },
    'employees',
    'emp-rollback',
  ), /revoke failed/);
  assert.equal((await stored('employees', 'emp-rollback')).archivedAt, undefined);
  assert.ok(await DB.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(people.tech).first());
});

for (const modular of [false, true]) {
  test(`employee access follows archive state (${modular ? 'module' : 'deployed'} handler)`, async () => {
    const { DB, seed, call, stored } = await setup(modular);
    const stale = { id: 'emp-tech', email: people.tech, name: 'Tech', active: true, role: 'technician' };
    await seed('employees', stale.id, stale);
    await seed('payrollentries', 'pay-row', { employeeId: stale.id, amount: 80 });
    assert.equal((await call('owner', 'DELETE', `employees/${stale.id}`)).status, 200);
    const archived = await stored('employees', stale.id);
    const access = () => DB.prepare('SELECT enabled FROM users WHERE email = ?').bind(people.tech).first();

    for (const [method, path, body] of [
      ['PUT', `employees/${stale.id}`, stale],
      ['PUT', `employees/${stale.id}`, { ...archived, active: true }],
      ['POST', 'employees', stale],
    ]) {
      const response = await call('owner', method, path, body);
      assert.equal(response.status, method === 'POST' ? 201 : 200);
      const saved = await response.json();
      assert.equal(saved.archivedAt, archived.archivedAt);
      assert.equal(saved.active, false);
      assert.equal((await stored('employees', stale.id)).active, false);
      assert.equal((await access()).enabled, 0);
    }

    const before = await stored('employees', stale.id);
    assert.equal((await call('writer', 'PUT', `employees/${stale.id}`, { ...stale, archivedAt: null })).status, 403);
    assert.deepEqual(await stored('employees', stale.id), before);
    assert.equal((await access()).enabled, 0);

    await DB.prepare('INSERT INTO users (email, shop_id, role, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('other@shop.test', 'other-shop', 'technician', 'Other', stamp, stamp).run();
    const conflict = await call('owner', 'PUT', `employees/${stale.id}`, {
      ...stale, email: 'other@shop.test', archivedAt: null,
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await stored('employees', stale.id), before);

    const restored = await call('owner', 'PUT', `employees/${stale.id}`, { ...stale, archivedAt: null });
    assert.equal(restored.status, 200);
    assert.equal((await stored('employees', stale.id)).archivedAt, null);
    assert.equal((await stored('employees', stale.id)).active, true);
    assert.equal((await access()).enabled, 1);
  });
}

for (const modular of [false, true]) {
  test(`deleting an already-archived employee revokes Access (${modular ? 'module' : 'deployed'} handler)`, async () => {
    const { DB, seed, call } = await setup(modular);
    await seed('employees', 'emp-archived', {
      email: people.tech, name: 'Tech', active: false, role: 'technician', archivedAt: stamp,
    });

    const response = await call('owner', 'DELETE', 'employees/emp-archived');
    assert.equal(response.status, 200);
    assert.equal(await DB.prepare('SELECT 1 AS found FROM users WHERE email = ?').bind(people.tech).first(), null);
  });
}

test('stale saves keep the archive flag; only owners/admins restore', async () => {
  const { seed, call, stored } = await setup();
  await seed('invoices', 'INV-3', { number: 'INV-3', customer: 'Pat', amount: 20 });
  await seed('invoices', 'INV-4', { number: 'INV-4', customer: 'Pat', amount: 20 });
  assert.equal((await call('writer', 'PUT', 'invoices/INV-4', {
    id: 'INV-4', number: 'INV-4', archivedAt: '2026-10-31T12:00:00.000Z',
  })).status, 403);
  assert.equal((await call('admin', 'DELETE', 'invoices/INV-3')).status, 200);
  const save = await call('writer', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', customer: 'Pat', amount: 25 });
  assert.equal(save.status, 200);
  assert.ok((await stored('invoices', 'INV-3')).archivedAt, 'a stale save must not un-archive');
  assert.equal((await call('owner', 'PUT', 'invoices/INV-3', {
    id: 'INV-3', number: 'INV-3', archivedAt: '',
  })).status, 400);
  assert.equal((await call('writer', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', archivedAt: null })).status, 403);
  assert.equal((await call('owner', 'PUT', 'invoices/INV-3', { id: 'INV-3', number: 'INV-3', customer: 'Pat', amount: 25, archivedAt: null })).status, 200);
  assert.equal((await stored('invoices', 'INV-3')).archivedAt, null);
});

for (const modular of [false, true]) {
  test(`PUT rejects empty archive timestamps (${modular ? 'module' : 'deployed'} handler)`, async () => {
    const { seed, call, stored } = await setup(modular);
    await seed('invoices', 'INV-4', { number: 'INV-4', customer: 'Pat', amount: 20 });
    const active = await call('owner', 'PUT', 'invoices/INV-4', { id: 'INV-4', archivedAt: ' ' });
    assert.equal(active.status, 400);
    assert.equal((await stored('invoices', 'INV-4')).archivedAt, undefined);

    await call('owner', 'DELETE', 'invoices/INV-4');
    const archived = await call('writer', 'PUT', 'invoices/INV-4', { id: 'INV-4', archivedAt: '' });
    assert.equal(archived.status, 400);
    assert.ok((await stored('invoices', 'INV-4')).archivedAt);
  });
}

test('chat housekeeping keeps its membership rule', async () => {
  const { seed, call, stored } = await setup();
  await seed('conversations', 'conv-1', { kind: 'direct', memberEmails: [people.tech, people.writer] });
  await seed('chatmessages', 'msg-1', { conversationId: 'conv-1', body: 'hi', memberEmails: [people.tech, people.writer] });
  assert.equal((await call('owner', 'DELETE', 'chatmessages/msg-1')).status, 403, 'non-member cannot remove a message');
  assert.ok(await stored('chatmessages', 'msg-1'));
});
