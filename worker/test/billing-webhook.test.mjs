import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const secret = 'webhook-test-secret';

async function signedRequest(event) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  ));
  const signature = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://app.example.test/api/billing/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
    body: payload,
  });
}

function billingDb({ failSubscriptionWrite = false, subscription = null } = {}) {
  const state = {
    events: new Map(),
    subscription: subscription && { ...subscription },
    failed: false,
    subscriptionWrites: [],
    accountWrites: [],
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT id FROM billing_events/.test(sql)) {
                return state.events.has(args[0]) ? { id: args[0] } : null;
              }
              if (/SELECT plan_id, stripe_subscription_id/.test(sql)) return state.subscription;
              return null;
            },
            async run() {
              if (/INSERT INTO subscriptions/.test(sql)) {
                if (failSubscriptionWrite && !state.failed) {
                  state.failed = true;
                  throw new Error('temporary D1 failure');
                }
                state.subscriptionWrites.push(args);
                state.subscription = {
                  plan_id: args[2],
                  status: args[3],
                  current_period_end: args[4],
                  current_period_start: args[5],
                  stripe_subscription_id: args[1],
                };
              } else if (/UPDATE accounts SET subscription_status/.test(sql)) {
                state.accountWrites.push(args);
              } else if (/INSERT OR IGNORE INTO billing_events/.test(sql)) {
                state.events.set(args[0], { id: args[0] });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { DB, state };
}

test('failed billing updates remain retryable because the event is not marked complete first', async () => {
  const event = {
    id: 'evt-retry-1',
    type: 'customer.subscription.updated',
    data: { object: {
      id: 'sub-1',
      status: 'active',
      current_period_end: 1_800_000_000,
      current_period_start: 1_700_000_000,
      metadata: { shopId: 'shop-1', planId: 'shop' },
    } },
  };
  const { DB, state } = billingDb({ failSubscriptionWrite: true });
  const env = { DB, STRIPE_BILLING_WEBHOOK_SECRET: secret };

  assert.equal((await worker.fetch(await signedRequest(event), env)).status, 500);
  assert.equal(state.events.has(event.id), false);
  assert.equal((await worker.fetch(await signedRequest(event), env)).status, 202);
  assert.equal(state.events.has(event.id), true);
  const duplicate = await worker.fetch(await signedRequest(event), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
});

test('invoice payment failures preserve subscription IDs and billing periods', async () => {
  const periodEnd = '2027-01-01T00:00:00.000Z';
  const periodStart = '2026-12-01T00:00:00.000Z';
  const event = {
    id: 'evt-payment-failed-1',
    type: 'invoice.payment_failed',
    data: { object: {
      id: 'in-failed-invoice',
      subscription: 'sub-existing',
      customer: 'cus-1',
      metadata: { shopId: 'shop-1' },
    } },
  };
  const { DB, state } = billingDb({
    subscription: {
      plan_id: 'shop',
      stripe_subscription_id: 'sub-existing',
      current_period_end: periodEnd,
      current_period_start: periodStart,
    },
  });
  const response = await worker.fetch(await signedRequest(event), {
    DB,
    STRIPE_BILLING_WEBHOOK_SECRET: secret,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(state.subscriptionWrites[0].slice(1, 6), [
    'sub-existing',
    'shop',
    'past_due',
    periodEnd,
    periodStart,
  ]);
  assert.deepEqual(state.accountWrites[0].slice(0, 2), ['past_due', periodEnd]);
});
