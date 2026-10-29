import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';

// Regression coverage for the five release blockers in
// .10x/reviews/2026-10-20-qa-report.md, exercised against the real Worker and
// every migration on SQLite. The client-side halves (sanitizer-safe field
// names, payroll shadowing, demo seed) live in src/runtime/audit-showstoppers.test.mjs.

const ORIGIN = 'https://app.example.test';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function signUp(env, { shopName, ownerName = 'Sam Owner', email }) {
  const start = await worker.fetch(new Request(`${ORIGIN}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.90' },
    body: JSON.stringify({ email, shopName, ownerName, intent: 'signup', returnTo: '/' }),
  }), env);
  assert.equal(start.status, 200);
  const token = new URL((await start.json()).loginUrl).searchParams.get('token');
  const confirm = await worker.fetch(new Request(`${ORIGIN}/api/auth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: `token=${token}`,
  }), env);
  const cookie = (confirm.headers.get('Set-Cookie') || '').split(';')[0];
  assert.match(cookie, /^shopcrank_session=/, 'signup produced a session');
  return (path, init = {}) => worker.fetch(new Request(`${ORIGIN}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie, ...(init.headers || {}) },
  }), env);
}

function freshEnv() {
  return { DB: createD1(), AUTH_EXPOSE_LOGIN_LINK: '1', ALLOWED_ORIGINS: ORIGIN };
}

test('blocker 4: a new shop is seeded with its own signup name, never the demo identity', async () => {
  const env = freshEnv();
  const api = await signUp(env, { shopName: 'Lubbock Brake & Tire', email: 'owner@lbt.example' });
  const profile = await (await api('/entities/shopsettings/profile')).json();
  assert.equal(profile.shopName, 'Lubbock Brake & Tire');
  const text = JSON.stringify(profile);
  for (const leaked of ['Your Car Guy', '100 Demo Street', '555-0100', 'reliable-logo']) {
    assert.ok(!text.includes(leaked), `profile must not contain ${leaked}`);
  }
});

test('blocker 5: a new cloud shop starts with no work orders, customers, invoices, or payments', async () => {
  const env = freshEnv();
  const api = await signUp(env, { shopName: 'Clean Start Auto', email: 'owner@clean.example' });
  for (const type of ['orders', 'customers', 'invoices', 'payments', 'appointments', 'expenses']) {
    const response = await api(`/entities/${type}`);
    assert.equal(response.status, 200, type);
    assert.deepEqual(await response.json(), [], `${type} should be empty for a brand-new shop`);
  }
});

test('blocker 2: adding a customer stores the name the form submitted', async () => {
  const env = freshEnv();
  const api = await signUp(env, { shopName: 'Customer Test Garage', email: 'owner@cust.example' });
  const created = await api('/entities/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice Brooks', phone: '806-555-0101', email: 'alice@example.com' }),
  });
  assert.ok([200, 201].includes(created.status), `create returned ${created.status}`);
  const list = await (await api('/entities/customers')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Alice Brooks');
});

test('blocker 1: recording a cash/check payment succeeds and settles the invoice', async () => {
  const env = freshEnv();
  const api = await signUp(env, { shopName: 'Payment Test Garage', email: 'owner@pay.example' });
  const invoice = { number: 'INV-1001', customer: 'Alice Brooks', total: 150, status: 'sent', date: '2026-10-20' };
  const put = await api('/entities/invoices/INV-1001', { method: 'PUT', body: JSON.stringify(invoice) });
  assert.ok([200, 201].includes(put.status), `invoice save returned ${put.status}`);

  // The original defect: the sanitizer stripped name="method", so the body had no
  // method and the server answered 400 "Unsupported payment method".
  const missing = await api('/payments/record', {
    method: 'POST', body: JSON.stringify({ targetType: 'invoice', targetId: 'INV-1001', amount: 50 }),
  });
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /Unsupported payment method/);

  for (const [amount, method] of [[100, 'cash'], [50, 'check']]) {
    const response = await api('/payments/record', {
      method: 'POST',
      body: JSON.stringify({ targetType: 'invoice', targetId: 'INV-1001', amount, method, receivedAt: new Date().toISOString(), reference: '', note: '' }),
    });
    assert.equal(response.status, 201, `${method} payment`);
  }
  const saved = await (await api('/entities/invoices/INV-1001')).json();
  assert.equal(saved.status, 'paid');
  assert.equal(saved.balanceDue, 0);
});

test('blocker 4: migration 0015 repairs a profile already saved with the demo identity', () => {
  const env = createD1([]);
  const files = ['0001_initial.sql', '0002_public_saas_auth.sql'];
  for (const name of files) env.sqlite.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  env.sqlite.exec(`INSERT INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at)
    VALUES ('shop-a', 'Real Shop Name', 'shop-a', 'America/Chicago', 'trialing', 'now', 'now')`);
  const demo = JSON.stringify({ id: 'profile', shopName: 'Your Car Guy', phone: '555-0100', address: '100 Demo Street, Example City, TX 00000', logoUrl: '/assets/reliable-logo.jpg' });
  const real = JSON.stringify({ id: 'profile', shopName: 'Owner Typed This', phone: '806-555-1234', address: '1 Real Rd', logoUrl: '/files/logo.png' });
  const insert = env.sqlite.prepare(`INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, 'shopsettings', 'profile', ?, 'u', 'now', 'now')`);
  insert.run('shop-a', demo);
  insert.run('shop-b', real);
  env.sqlite.exec(readFileSync(join(migrationsDir, '0015_repair_demo_shop_profiles.sql'), 'utf8'));
  const read = shop => JSON.parse(env.sqlite.prepare(`SELECT data_json FROM entities WHERE shop_id = ?`).get(shop).data_json);
  const repaired = read('shop-a');
  assert.equal(repaired.shopName, 'Real Shop Name');
  assert.equal(repaired.phone, '');
  assert.equal(repaired.address, '');
  assert.equal(repaired.logoUrl, '');
  assert.deepEqual(read('shop-b'), JSON.parse(real), 'real profiles are untouched');
});
