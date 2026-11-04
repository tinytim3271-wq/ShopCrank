import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_SEARCH_MIN_LENGTH,
  findDuplicateCustomers,
  handleCustomerLookup,
  searchCustomers,
} from '../src/customer-search.mjs';
import { HttpError } from '../src/http.mjs';

function mockDb(rows = []) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...args) {
          statements.push({ sql, args });
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

test('customer name search enforces the shared three-character server threshold', async () => {
  const env = { DB: mockDb() };
  assert.equal(CUSTOMER_SEARCH_MIN_LENGTH, 3);
  await assert.rejects(
    () => searchCustomers(env, 'shop-1', 'ga'),
    error => error instanceof HttpError && error.status === 400,
  );
  await searchCustomers(env, 'shop-1', 'gal');
  assert.equal(env.DB.statements.length, 1);
});

test('customer name search is shop scoped, tokenized, bounded, and order independent', async () => {
  const rows = [{
    entity_id: 'customer-1',
    data_json: JSON.stringify({
      id: 'customer-1',
      name: 'Isaac Gallardo',
      phone: '555-0101',
      email: 'isaac@example.com',
      billingAddress: '1 Main St',
    }),
    vehicle_json: JSON.stringify({ id: 'vehicle-1', year: 2021, make: 'Ford', model: 'F-150' }),
  }];
  const env = { DB: mockDb(rows) };
  const results = await searchCustomers(env, 'shop-42', 'Gall Isaac');
  const statement = env.DB.statements[0];

  assert.match(statement.sql, /shop_id = \?/);
  assert.match(statement.sql, /LIMIT \?/);
  assert.match(statement.sql, /json_extract\(data_json, '\$\.archivedAt'\) IS NULL/);
  assert.deepEqual(statement.args.slice(0, 3), ['shop-42', '%gall%', '%isaac%']);
  assert.equal(statement.args.at(-1), 'shop-42');
  assert.equal(results[0].name, 'Isaac Gallardo');
  assert.equal(results[0].vehicleCount, 1);
  assert.equal(results[0].recentVehicle.label, '2021 Ford F-150');
});

test('duplicate lookup compares bounded phone or email within the same shop', async () => {
  const env = { DB: mockDb() };
  await findDuplicateCustomers(env, 'shop-7', {
    phone: '(555) 010-2000',
    email: 'OWNER@EXAMPLE.COM',
  });
  const statement = env.DB.statements[0];
  assert.equal(statement.args[0], 'shop-7');
  assert.match(statement.sql, /json_extract\(data_json, '\$\.archivedAt'\) IS NULL/);
  assert.ok(statement.args.includes('5550102000'));
  assert.ok(statement.args.includes('owner@example.com'));
  assert.equal(statement.args.at(-1), 'shop-7');
});

test('customer search response documents the minimum and rejects unsupported methods', async () => {
  const env = { DB: mockDb() };
  const context = { shopId: 'shop-1', role: 'service_writer' };
  const response = await handleCustomerLookup(
    new Request('https://example.test/api/customers/search?q=gall'),
    env,
    context,
    'search',
  );
  assert.deepEqual(await response.json(), { query: 'gall', minLength: 3, results: [] });
  await assert.rejects(
    () => handleCustomerLookup(new Request('https://example.test/api/customers/search', { method: 'POST' }), env, context, 'search'),
    error => error instanceof HttpError && error.status === 405,
  );
});
