import test from 'node:test';
import assert from 'node:assert/strict';
import { createPartstechHandlers } from '../src/integrations/partstech.mjs';
import { createLaborGuideHandlers } from '../src/integrations/labor-guide.mjs';
import { createQuickbooksHandlers } from '../src/integrations/quickbooks.mjs';
import { HttpError } from '../src/http.mjs';

function secretsStore() {
  const map = new Map();
  return {
    async saveSecret(_env, shopId, name, value) { map.set(`${shopId}:${name}`, value); },
    async getSecret(shopId, name) { return map.get(`${shopId}:${name}`) || ''; },
    async deleteSecret(_env, shopId, name) { map.delete(`${shopId}:${name}`); },
    map,
  };
}

function requireRole(context, roles) {
  if (!roles.includes(context.role) && context.role !== 'super_admin') {
    throw new HttpError(403, 'Forbidden');
  }
}

test('partstech quote fails closed when not connected', async () => {
  const store = secretsStore();
  const handle = createPartstechHandlers({
    ...store,
    requireRole,
  });
  const context = { shopId: 'shop-1', role: 'admin', userId: 'u1' };
  await assert.rejects(
    () => handle(new Request('https://example/api/integrations/partstech/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'pad', storeId: '1' }),
    }), {}, context, ['integrations', 'partstech', 'quote']),
    /not connected/i,
  );
});

test('labor guide search without provider returns labeled web miss when search unset', async () => {
  const store = secretsStore();
  const handle = createLaborGuideHandlers({ ...store, requireRole });
  const context = { shopId: 'shop-1', role: 'service_writer', userId: 'u1' };
  const response = await handle(new Request('https://example/api/integrations/labor-guide/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: 2022, make: 'Ford', model: 'F-150', keyword: 'brake' }),
  }), {}, context, ['integrations', 'labor-guide', 'search']);
  const body = await response.json();
  assert.equal(body.provider, 'web_estimate');
  assert.equal(body.found, false);
  assert.equal(body.message, 'no estimate found');
  assert.match(body.label, /not book time/i);
});

test('quickbooks sync fails closed when not connected', async () => {
  const store = secretsStore();
  const handle = createQuickbooksHandlers({ ...store, requireRole });
  const context = { shopId: 'shop-1', role: 'admin', userId: 'u1' };
  await assert.rejects(
    () => handle(new Request('https://example/api/integrations/quickbooks/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'customer', localId: 'c1', customer: { name: 'Pat' } }),
    }), {}, context, ['integrations', 'quickbooks', 'sync']),
    /not connected/i,
  );
});

test('partstech connect stores encrypted-ready JSON secret payload', async () => {
  const store = secretsStore();
  const handle = createPartstechHandlers({ ...store, requireRole });
  const context = { shopId: 'shop-1', role: 'owner', userId: 'u1' };
  const response = await handle(new Request('https://example/api/integrations/partstech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partnerId: 'p', partnerKey: 'pk', userId: 'u', userKey: 'uk', storeId: 'store-1',
    }),
  }), {}, context, ['integrations', 'partstech']);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.connected, true);
  assert.ok(store.map.get('shop-1:partstech-credentials'));
});

async function connectedPartstech(fetchImpl) {
  const store = secretsStore();
  store.map.set('shop-1:partstech-credentials', JSON.stringify({
    partnerId: 'p', partnerKey: 'pk', userId: 'u', userKey: 'uk', storeId: '77',
  }));
  const audits = [];
  const handle = createPartstechHandlers({ ...store, requireRole, recordAudit: async (_env, _ctx, event) => audits.push(event) });
  const calls = [];
  const env = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/oauth/access')) return Response.json({ accessToken: 'tok' });
      return fetchImpl(String(url), init);
    },
  };
  return { handle, env, calls, audits };
}

const tech = { shopId: 'shop-1', role: 'technician', userId: 't1' };
const post = (path, body) => new Request(`https://example/api/integrations/partstech/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('partstech quote returns real prices from nested price objects', async () => {
  const { handle, env, calls } = await connectedPartstech(async () => Response.json({
    quoteId: 'Q1',
    parts: [{ partId: 'p1', partNumber: 'D1092', brand: { name: 'Wagner' }, price: { list: 68.99, cost: 34.1 } }],
  }));
  const response = await handle(post('quote', { keyword: 'D1092', vin: '1C6SRFHT0LN123456' }), env, tech, ['integrations', 'partstech', 'quote']);
  const body = await response.json();
  assert.equal(body.items[0].unitPrice, 68.99);
  assert.equal(body.unpriced, 0);
  assert.deepEqual(calls[1].body, { storeId: '77', searchParams: { partNumber: 'D1092', vin: '1C6SRFHT0LN123456' } });
});

test('partstech order posts a clean cart and returns the checkout session', async () => {
  const { handle, env, calls, audits } = await connectedPartstech(async () => Response.json({
    sessionId: 'sess-123', redirectUrl: 'https://app.partstech.com/punchout/sess-123',
  }));
  const response = await handle(post('order', {
    repairOrderId: 'RO-1050',
    lines: [{ type: 'part', partNumber: 'D1092', quantity: 1, total: 68.99, approvalStatus: 'approved', partstech: { brand: 'Wagner', partId: 'p1' } }],
  }), env, tech, ['integrations', 'partstech', 'order']);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.sessionId, 'sess-123');
  assert.equal(body.status, 'checkout_pending');
  assert.ok(calls[1].url.endsWith('/punchout/quote/create'));
  assert.deepEqual(calls[1].body, {
    storeId: '77', poNumber: 'RO-1050', parts: [{ partNumber: 'D1092', quantity: 1, brand: 'Wagner', partId: 'p1' }],
  });
  assert.equal(audits.at(-1).kind, 'integrations.partstech.order_session');
});

test('partstech order rejects malformed carts and untrusted redirects', async () => {
  const { handle, env } = await connectedPartstech(async () => Response.json({ sessionId: 's', redirectUrl: 'https://evil.example/phish' }));
  await assert.rejects(
    handle(post('order', { lines: [{ type: 'part', description: 'No number' }] }), env, tech, ['integrations', 'partstech', 'order']),
    error => error.status === 400,
  );
  await assert.rejects(
    handle(post('order', { lines: [{ type: 'part', partNumber: 'A1', quantity: 1 }] }), env, tech, ['integrations', 'partstech', 'order']),
    error => error.status === 502,
  );
});

test('partstech order status reads the punch-out session', async () => {
  const { handle, env, calls } = await connectedPartstech(async () => Response.json({ orders: [{ id: 'PO-55', status: 'confirmed' }] }));
  const response = await handle(post('order/status', { sessionId: 'sess-123' }), env, tech, ['integrations', 'partstech', 'order', 'status']);
  const body = await response.json();
  assert.equal(body.order.orderId, 'PO-55');
  assert.ok(calls[1].url.endsWith('/punchout/quote/info'));
});
