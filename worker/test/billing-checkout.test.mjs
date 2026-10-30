import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin = 'https://app.example.test';

function billingEnv(role = 'admin', shopId = 'shop-a') {
  const calls = [];
  return {
    calls,
    DEV_AUTH_BYPASS: '1',
    STRIPE_SECRET_KEY: 'stripe-test-key',
    STRIPE_PRICE_SHOP_MONTHLY: 'price_1ABC123xyz',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              async first() {
                if (/FROM users WHERE email/.test(sql)) return { shop_id: shopId, role, name: 'Owner', enabled: 1 };
                if (/SELECT \* FROM plans/.test(sql)) return { id: 'shop', active: 1, public: 1, founding: 0 };
                if (/SELECT stripe_customer_id FROM billing_customers/.test(sql)) return { stripe_customer_id: `cus_${args[0]}` };
                return null;
              },
              async run() { return { success: true, meta: { changes: 1 } }; },
            };
          },
        };
      },
    },
  };
}

function billingRequest(action, body = {}, authenticated = true) {
  return new Request(`${origin}/api/billing/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'X-ShopCrank-Dev-Email': 'owner@example.test' } : {}),
    },
    body: JSON.stringify({ planId: 'shop', ...body }),
  });
}

test('billing checkout rejects invalid or foreign redirects before contacting Stripe', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('invalid redirects must not contact Stripe');
  try {
    for (const invalid of ['https://attacker.example/paid', '//attacker.example', '/relative', 'not a URL', 'javascript:alert(1)', 'data:text/html,test', '', 'https://app.example.test.attacker.example/']) {
      for (const field of ['successUrl', 'cancelUrl']) {
        const response = await worker.fetch(billingRequest('checkout', { [field]: invalid }), billingEnv());
        assert.equal(response.status, 400, `${field}: ${invalid}`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('billing checkout accepts same-origin redirects and supplies safe defaults', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, params: new URLSearchParams(options.body) });
    return Response.json({ url: 'https://checkout.stripe.test/session' });
  };
  try {
    const successUrl = `${origin}/app?billing=success#paid`;
    const cancelUrl = `${origin}/pricing?billing=cancelled`;
    assert.equal((await worker.fetch(billingRequest('checkout', { successUrl, cancelUrl }), billingEnv())).status, 200);
    assert.equal(requests[0].params.get('success_url'), successUrl);
    assert.equal(requests[0].params.get('cancel_url'), cancelUrl);
    assert.equal((await worker.fetch(billingRequest('checkout'), billingEnv())).status, 200);
    assert.equal(requests[1].params.get('success_url'), `${origin}/?billing=success`);
    assert.equal(requests[1].params.get('cancel_url'), `${origin}/?billing=cancelled`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('billing portal denies unauthenticated and non-admin callers without customer access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('unauthorized portal requests must not contact Stripe');
  try {
    for (const role of ['technician', 'lead_tech', 'payroll', 'accountant', 'manager']) {
      const env = billingEnv(role);
      assert.equal((await worker.fetch(billingRequest('portal'), env)).status, 403, role);
      assert.equal(env.calls.some(call => call.sql.includes('billing_customers')), false);
    }
    const env = billingEnv();
    assert.equal((await worker.fetch(billingRequest('portal', {}, false), env)).status, 401);
    assert.equal(env.calls.some(call => call.sql.includes('billing_customers')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin and super_admin billing portals use only the authenticated tenant customer', async () => {
  const originalFetch = globalThis.fetch;
  const customers = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/billing_portal/sessions');
    const params = new URLSearchParams(options.body);
    customers.push(params.get('customer'));
    assert.equal(params.get('return_url'), `${origin}/app`);
    return Response.json({ url: 'https://billing.stripe.test/session' });
  };
  try {
    for (const role of ['admin', 'super_admin']) {
      const env = billingEnv(role, `shop-${role}`);
      const response = await worker.fetch(billingRequest('portal', { shopId: 'victim', customer: 'cus_victim' }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).shopId, `shop-${role}`);
      const lookup = env.calls.find(call => call.sql.includes('billing_customers'));
      assert.deepEqual(lookup.args, [`shop-${role}`]);
    }
    assert.deepEqual(customers, ['cus_shop-admin', 'cus_shop-super_admin']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
