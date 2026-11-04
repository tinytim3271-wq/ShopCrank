import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_PREFIX, PRODUCT_ID, main, overageRates } from './stripe-overage-setup.mjs';

/** In-memory stand-in for the Stripe CLI (`stripe get|post <path> -d k=v`). */
function fakeStripe({ subscriptions = [] } = {}) {
  const state = { meters: [], products: new Map(), prices: [], subscriptions, calls: [] };
  let next = 1;
  const parse = args => {
    const params = {};
    for (let i = 2; i < args.length; i += 2) {
      const [key, ...rest] = args[i + 1].split('=');
      params[key] = rest.join('=');
    }
    return params;
  };
  const run = (args) => {
    const [verb, path] = args;
    const params = parse(args);
    state.calls.push(`${verb} ${path}`);
    if (verb === 'get' && path === '/v1/billing/meters') return { data: state.meters };
    if (verb === 'post' && path === '/v1/billing/meters') { const meter = { id: `mtr_${next++}`, event_name: params.event_name, status: 'active', params }; state.meters.push(meter); return meter; }
    if (verb === 'get' && path.startsWith('/v1/products/')) return state.products.get(path.split('/').pop()) || { error: { message: 'No such product' } };
    if (verb === 'post' && path === '/v1/products') { const product = { id: params.id, name: params.name }; state.products.set(params.id, product); return product; }
    if (verb === 'get' && path === '/v1/prices') return { data: state.prices.filter(price => price.lookup_key === params['lookup_keys[]']) };
    if (verb === 'post' && path === '/v1/prices') {
      const price = { id: `price_${next++}`, lookup_key: params.lookup_key, unit_amount: Number(params.unit_amount), recurring: { interval: params['recurring[interval]'], usage_type: params['recurring[usage_type]'], meter: params['recurring[meter]'] } };
      state.prices.push(price);
      return price;
    }
    if (verb === 'get' && path === '/v1/subscriptions') return { data: state.subscriptions.filter(sub => sub.status === params.status), has_more: false };
    if (verb === 'post' && path === '/v1/subscription_items') {
      const sub = state.subscriptions.find(item => item.id === params.subscription);
      const price = state.prices.find(item => item.id === params.price);
      assert.equal(params.quantity, undefined, 'metered items take no quantity');
      sub.items.data.push({ price });
      return { id: `si_${next++}` };
    }
    throw new Error(`unexpected ${verb} ${path}`);
  };
  return { run, state };
}

const sub = (id, planId, interval = 'month', status = 'active') => ({ id, status, metadata: { planId }, items: { data: [{ price: { id: `price_plan_${planId}`, recurring: { interval, usage_type: 'licensed' } } }] } });

test('creates the meter, one product and a metered price per rate and interval, and is safe to rerun', () => {
  const { run, state } = fakeStripe();
  const quiet = () => {};
  const first = main([], { stripe: run, log: quiet });
  assert.deepEqual(overageRates(), [15, 12, 10, 8]);
  assert.equal(state.meters.length, 1);
  assert.deepEqual(state.meters[0].params, {
    display_name: 'AI phone minutes', event_name: 'ai_phone_minutes', 'default_aggregation[formula]': 'sum',
    'customer_mapping[event_payload_key]': 'stripe_customer_id', 'customer_mapping[type]': 'by_id', 'value_settings[event_payload_key]': 'value',
  });
  assert.ok(state.products.has(PRODUCT_ID));
  assert.equal(state.prices.length, 8);
  const shopMonthly = state.prices.find(price => price.lookup_key === `${LOOKUP_PREFIX}12c_month`);
  assert.deepEqual(shopMonthly.recurring, { interval: 'month', usage_type: 'metered', meter: first.meterId });
  assert.equal(shopMonthly.unit_amount, 12);
  main([], { stripe: run, log: quiet });
  assert.equal(state.meters.length, 1, 'no second meter');
  assert.equal(state.prices.length, 8, 'no duplicate prices');
});

test('existing subscriptions are only listed until --apply, then get the price for their plan and interval', () => {
  const subscriptions = [sub('sub_solo', 'solo'), sub('sub_shop_year', 'shop', 'year', 'trialing'), sub('sub_founding', 'founding_pro'), sub('sub_other', '')];
  const { run, state } = fakeStripe({ subscriptions });
  const lines = [];
  const dry = main([], { stripe: run, log: line => lines.push(line) });
  assert.equal(dry.report.wouldAdd.length, 3);
  assert.deepEqual(dry.report.skipped, ['sub_other (plan "unknown")']);
  assert.ok(!state.calls.includes('post /v1/subscription_items'));
  assert.ok(lines.some(line => /--apply/.test(line)));

  const applied = main(['--apply'], { stripe: run, log: () => {} });
  assert.deepEqual([...applied.report.added].sort(), ['sub_founding', 'sub_shop_year', 'sub_solo']);
  const added = id => subscriptions.find(item => item.id === id).items.data.at(-1).price.lookup_key;
  assert.equal(added('sub_solo'), `${LOOKUP_PREFIX}15c_month`);
  assert.equal(added('sub_shop_year'), `${LOOKUP_PREFIX}12c_year`);
  assert.equal(added('sub_founding'), `${LOOKUP_PREFIX}10c_month`);
  const again = main(['--apply'], { stripe: run, log: () => {} });
  assert.equal(again.report.added.length, 0, 'a subscription that has it is left alone');
});

test('a Stripe error stops the run with the reason', () => {
  const run = args => (args[1] === '/v1/billing/meters' ? { error: { message: 'Invalid API Key provided' } } : {});
  assert.throws(() => main([], { stripe: run, log: () => {} }), /listing meters: Invalid API Key provided/);
});
