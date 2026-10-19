import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuickBooks } from '../src/integration-routes.mjs';

const env = {
  INTUIT_CLIENT_ID: 'client-id',
  INTUIT_CLIENT_SECRET: 'client-secret',
  INTUIT_REDIRECT_URI: 'https://app.example.test/oauth/quickbooks/callback',
  INTUIT_ENVIRONMENT: 'sandbox',
  INTUIT_DEFAULT_ITEM_ID: 'default-item',
};

function createDependencies({ realmId = 'realm-current', mappings = [] } = {}) {
  const syncRecords = [...mappings];
  const records = {
    invoices: {
      id: 'invoice-1',
      number: 'INV-1',
      customerId: 'customer-1',
      date: '2026-10-08',
      subtotal: 10,
      lines: [{ description: 'Labor', quantity: 1, unitPrice: 10 }],
    },
    customers: { id: 'customer-1', name: 'Ada Lovelace' },
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (!/SELECT remote_id FROM integration_sync_records/.test(sql)) return null;
              return syncRecords.find(record => record.shopId === args[0]
                && record.entityType === args[1]
                && record.localId === args[2]
                && record.realmId === args[3]) || null;
            },
            async run() {
              if (/INSERT INTO integration_sync_records/.test(sql)) {
                const [shopId, entityType, localId, remoteId, recordRealmId] = args;
                const existing = syncRecords.find(record => record.shopId === shopId
                  && record.entityType === entityType
                  && record.localId === localId);
                if (existing) Object.assign(existing, { remote_id: remoteId, realmId: recordRealmId });
                else syncRecords.push({
                  shopId,
                  entityType,
                  localId,
                  remote_id: remoteId,
                  realmId: recordRealmId,
                });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return {
    DB,
    records,
    syncRecords,
    async getSecret(_env, _shopId, name) {
      if (name !== 'quickbooks-oauth-tokens') return '';
      return JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3_600_000,
        realmId,
      });
    },
    async saveSecret() {},
    async deleteSecret() {},
    async getEntity(_env, _shopId, collection, id) {
      return records[collection]?.id === id ? records[collection] : null;
    },
  };
}

async function syncInvoice(dependencies) {
  return handleQuickBooks(
    new Request('https://app.example.test/api/quickbooks/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'invoice', entityId: 'invoice-1' }),
    }),
    { ...env, DB: dependencies.DB },
    { shopId: 'shop-1', role: 'owner' },
    ['quickbooks', 'sync'],
    dependencies,
  );
}

test('invoice sync supplies the default item to every unmapped line and scopes customer IDs by realm', async () => {
  const dependencies = createDependencies({
    realmId: 'realm-new',
    mappings: [{
      shopId: 'shop-1',
      entityType: 'customer',
      localId: 'customer-1',
      remote_id: 'customer-from-old-realm',
      realmId: 'realm-old',
    }],
  });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/preferences')) return Response.json({ Preferences: { TaxPrefs: { UsingSalesTax: false } } });
    if (String(url).includes('/companyinfo/')) return Response.json({ CompanyInfo: { Country: 'US' } });
    if (String(url).includes('/query')) return Response.json({ QueryResponse: {} });
    const data = String(url).includes('/customer')
      ? { Customer: { Id: 'customer-in-new-realm' } }
      : { Invoice: { Id: 'invoice-in-new-realm' } };
    return Response.json(data);
  };
  try {
    const response = await syncInvoice(dependencies);
    assert.equal(response.status, 201);
    const invoice = requests.find(request => request.url.includes('/invoice'));
    assert.equal(invoice.body.CustomerRef.value, 'customer-in-new-realm');
    assert.equal(invoice.body.Line[0].SalesItemLineDetail.ItemRef.value, 'default-item');
    assert.equal(dependencies.syncRecords.find(record => record.entityType === 'invoice').realmId, 'realm-new');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invoice sync rejects records already mapped in the connected QuickBooks realm', async () => {
  const dependencies = createDependencies({
    mappings: [{
      shopId: 'shop-1',
      entityType: 'invoice',
      localId: 'invoice-1',
      remote_id: 'invoice-existing',
      realmId: 'realm-current',
    }],
  });
  await assert.rejects(
    syncInvoice(dependencies),
    error => error.status === 409 && /already synced/u.test(error.message),
  );
});

test('QuickBooks tax settings only accept active company tax codes', async () => {
  const dependencies = createDependencies();
  const saved = new Map();
  dependencies.saveSecret = async (_env, _shopId, name, value) => saved.set(name, value);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/preferences')) return Response.json({ Preferences: { TaxPrefs: { UsingSalesTax: true } } });
    if (String(url).includes('/companyinfo/')) return Response.json({ CompanyInfo: { Country: 'US' } });
    return Response.json({ QueryResponse: { TaxCode: [{ Id: '3', Name: 'County 8.25%', Taxable: true }, { Id: '5', Name: 'City 6%', Taxable: true }] } });
  };
  const put = body => handleQuickBooks(
    new Request('https://app.example.test/api/quickbooks/tax-settings', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    { ...env, DB: dependencies.DB },
    { shopId: 'shop-1', role: 'owner', userId: 'owner-1' },
    ['quickbooks', 'tax-settings'],
    dependencies,
  );
  try {
    await assert.rejects(put({ taxCodeId: '99' }), error => error.status === 400);
    const response = await put({ taxCodeId: '5' });
    const body = await response.json();
    assert.equal(body.mode, 'manual');
    assert.equal(body.taxCodeId, '5');
    assert.equal(JSON.parse(saved.get('quickbooks-tax-settings')).taxCodeId, '5');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
