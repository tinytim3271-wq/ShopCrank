import test from 'node:test';
import assert from 'node:assert/strict';
import { putEntity as saveWorkerEntity } from '../src/index.js';
import { putEntity as saveRouteEntity } from '../src/routes/entities.mjs';
import { createD1 } from './helpers/d1-sqlite.mjs';

const context = { shopId: 'shop-1', userId: 'admin-1' };
const savePaths = [
  ['Worker entity route', saveWorkerEntity],
  ['route module', saveRouteEntity],
];

for (const [name, saveEntity] of savePaths) {
  test(`${name} rejects invalid employee email and role without persisting an entity`, async () => {
    const DB = createD1();
    for (const [index, employee] of [
      { name: 'No Email', email: '  ', role: 'technician', active: true },
      { name: 'Unknown Role', email: 'unknown@shop.test', role: 'manager', active: true },
    ].entries()) {
      await assert.rejects(
        () => saveEntity({ DB }, context, 'employees', `employee-${index}`, employee, null, context.userId, { create: true }),
        error => error.status === 400,
      );
    }

    assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'employees'").first()).count, 0);
    assert.equal((await DB.prepare('SELECT COUNT(*) AS count FROM users').first()).count, 0);
  });

  test(`${name} commits employee revisions and Access state together`, async () => {
    const DB = createD1();
    const env = { DB };
    const employee = await saveEntity(env, context, 'employees', 'employee-1', {
      id: 'employee-1',
      name: 'Shop Technician',
      email: 'tech@shop.test',
      role: 'technician',
      active: true,
    }, null, context.userId, { create: true });

    await DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('session-1', (await DB.prepare('SELECT id FROM users WHERE email = ?').bind(employee.email).first()).id, 'token-hash', '2099-01-01', 'now')
      .run();

    const updates = await Promise.allSettled([
      saveEntity(env, context, 'employees', 'employee-1', { ...employee, active: false }, employee.updatedAt),
      saveEntity(env, context, 'employees', 'employee-1', { ...employee, active: true }, employee.updatedAt),
    ]);
    assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(updates.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);

    const row = await DB.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'employees' AND entity_id = ?")
      .bind(context.shopId, 'employee-1').first();
    const saved = JSON.parse(row.data_json);
    const access = await DB.prepare('SELECT enabled FROM users WHERE email = ?').bind(employee.email).first();
    assert.equal(access.enabled, saved.active ? 1 : 0);

    const session = await DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?').bind('session-1').first();
    assert.equal(Boolean(session.revoked_at), !saved.active);
  });
}
