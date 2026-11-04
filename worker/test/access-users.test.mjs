import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/http.mjs';
import { revokeSessionsForUserIds, syncAccessUser } from '../src/access-users.mjs';

function memoryUsersDb(seed = []) {
  const users = new Map(seed.map((row) => [String(row.email).toLowerCase(), { ...row }]));
  const employees = new Map();
  const sessionRevokes = [];
  return {
    users,
    employees,
    sessionRevokes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT id, shop_id FROM users/i.test(sql) || /SELECT id FROM users/i.test(sql)) {
                return users.get(String(args[0]).toLowerCase()) || null;
              }
              return null;
            },
            async run() {
              const guarded = /AND EXISTS\s*\(\s*SELECT 1 FROM entities/i.test(sql)
                || /WHERE EXISTS\s*\(\s*SELECT 1 FROM entities/i.test(sql);
              if (guarded) {
                const [shopId, employeeId, snapshot] = args.slice(-3);
                if (employees.get(`${shopId}:${employeeId}`) !== snapshot) {
                  return { success: true, meta: { changes: 0 } };
                }
              }
              if (/INSERT INTO users/i.test(sql)) {
                const [id, email, shopId, role, name, enabled] = args;
                users.set(String(email).toLowerCase(), {
                  id, email, shop_id: shopId, role, name, enabled,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (/UPDATE users/i.test(sql)) {
                const [role, name, enabled, _updatedAt, email, shopId] = args;
                const row = users.get(String(email).toLowerCase());
                assert.ok(row);
                assert.equal(row.shop_id, shopId);
                Object.assign(row, { role, name, enabled });
                return { success: true, meta: { changes: 1 } };
              }
              if (/UPDATE sessions SET revoked_at/i.test(sql)) {
                sessionRevokes.push({ revokedAt: args[0], userId: args[1] });
                return { success: true, meta: { changes: 1 } };
              }
              assert.fail(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('syncAccessUser refuses to move an existing user into another shop', async () => {
  const DB = memoryUsersDb([
    { id: 'user-b', email: 'victim@shop.test', shop_id: 'shop-b', role: 'admin', name: 'Victim', enabled: 1 },
  ]);
  await assert.rejects(
    () => syncAccessUser({ DB }, { shopId: 'shop-a' }, {
      email: 'victim@shop.test',
      role: 'technician',
      name: 'Stolen',
      active: true,
    }),
    (error) => error instanceof HttpError
      && error.status === 409
      && /another shop/i.test(error.message),
  );
  assert.equal(DB.users.get('victim@shop.test').shop_id, 'shop-b');
  assert.equal(DB.sessionRevokes.length, 0);
});

test('syncAccessUser updates role and revokes sessions for same-shop deactivate', async () => {
  const DB = memoryUsersDb([
    { id: 'user-1', email: 'tech@shop.test', shop_id: 'shop-a', role: 'technician', name: 'Tech', enabled: 1 },
  ]);
  const result = await syncAccessUser({ DB }, { shopId: 'shop-a' }, {
    email: 'tech@shop.test',
    role: 'office',
    name: 'Tech',
    active: false,
  });
  assert.equal(result.enabled, 0);
  assert.equal(DB.users.get('tech@shop.test').role, 'office');
  assert.equal(DB.users.get('tech@shop.test').enabled, 0);
  assert.equal(DB.users.get('tech@shop.test').shop_id, 'shop-a');
  assert.equal(DB.sessionRevokes.length, 1);
  assert.equal(DB.sessionRevokes[0].userId, 'user-1');
  assert.match(DB.sessionRevokes[0].revokedAt, /^\d{4}-/);
});

test('syncAccessUser applies a current employee snapshot to Access updates', async () => {
  const DB = memoryUsersDb([
    { id: 'user-1', email: 'tech@shop.test', shop_id: 'shop-a', role: 'technician', name: 'Tech', enabled: 0 },
  ]);
  const employeeSnapshot = {
    id: 'emp-1',
    email: 'tech@shop.test',
    role: 'technician',
    name: 'Tech',
    active: true,
  };
  DB.employees.set('shop-a:emp-1', JSON.stringify(employeeSnapshot));
  await syncAccessUser(
    { DB },
    { shopId: 'shop-a' },
    employeeSnapshot,
    { employeeSnapshot },
  );
  assert.equal(DB.users.get('tech@shop.test').enabled, 1);
});

test('syncAccessUser inserts a new shop-scoped user with an id', async () => {
  const DB = memoryUsersDb();
  const result = await syncAccessUser({ DB }, { shopId: 'shop-a' }, {
    email: 'new@shop.test',
    role: 'technician',
    name: 'New Tech',
    active: true,
  });
  const row = DB.users.get('new@shop.test');
  assert.ok(row);
  assert.equal(row.shop_id, 'shop-a');
  assert.equal(row.role, 'technician');
  assert.equal(row.enabled, 1);
  assert.equal(row.id, result.id);
  assert.match(row.id, /^[0-9a-f-]{36}$/i);
  assert.equal(DB.sessionRevokes.length, 0);
});

test('syncAccessUser applies a current employee snapshot to Access inserts', async () => {
  const DB = memoryUsersDb();
  const employeeSnapshot = {
    id: 'emp-1',
    email: 'new@shop.test',
    role: 'technician',
    name: 'New Tech',
    active: true,
  };
  DB.employees.set('shop-a:emp-1', JSON.stringify(employeeSnapshot));
  await syncAccessUser(
    { DB },
    { shopId: 'shop-a' },
    employeeSnapshot,
    { employeeSnapshot },
  );
  assert.equal(DB.users.get('new@shop.test').enabled, 1);
});

test('syncAccessUser skips an employee Access write when its saved snapshot is stale', async () => {
  const DB = memoryUsersDb([
    { id: 'user-1', email: 'tech@shop.test', shop_id: 'shop-a', role: 'technician', name: 'Tech', enabled: 0 },
  ]);
  const staleSnapshot = {
    id: 'emp-1',
    email: 'tech@shop.test',
    role: 'technician',
    name: 'Tech',
    active: true,
  };
  DB.employees.set('shop-a:emp-1', JSON.stringify({ ...staleSnapshot, active: false }));

  await syncAccessUser(
    { DB },
    { shopId: 'shop-a' },
    staleSnapshot,
    { employeeSnapshot: staleSnapshot },
  );

  assert.equal(DB.users.get('tech@shop.test').enabled, 0);
  assert.equal(DB.sessionRevokes.length, 0);
});

test('syncAccessUser guards employee Access inserts with the saved snapshot', async () => {
  const DB = memoryUsersDb();
  const staleSnapshot = {
    id: 'emp-1',
    email: 'new@shop.test',
    role: 'technician',
    name: 'New Tech',
    active: true,
  };
  DB.employees.set('shop-a:emp-1', JSON.stringify({ ...staleSnapshot, active: false }));

  await syncAccessUser(
    { DB },
    { shopId: 'shop-a' },
    staleSnapshot,
    { employeeSnapshot: staleSnapshot },
  );

  assert.equal(DB.users.has('new@shop.test'), false);
});

test('revokeSessionsForUserIds ignores blank ids', async () => {
  const DB = memoryUsersDb();
  await revokeSessionsForUserIds({ DB }, [null, '', 'user-1']);
  assert.deepEqual(DB.sessionRevokes.map((item) => item.userId), ['user-1']);
});
