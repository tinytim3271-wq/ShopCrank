#!/usr/bin/env node
// Sets up Stripe billing for extra AI phone minutes, using the Stripe CLI you
// are already logged in to (`stripe login`). Safe to run more than once.
//
//   node scripts/stripe-overage-setup.mjs            # test mode: meter + prices
//   node scripts/stripe-overage-setup.mjs --apply    # also add overage to existing test subscriptions
//   node scripts/stripe-overage-setup.mjs --live     # live mode (add --apply to update live subscriptions)
//
// 1. A billing meter "AI phone minutes" (event ai_phone_minutes, summed per customer).
// 2. One product with a metered price per overage rate and billing interval,
//    each with a lookup key the Worker finds at checkout
//    (shopcrank_ai_phone_overage_<cents>c_<month|year>).
// 3. With --apply: active and trialing subscriptions that lack the overage price
//    get it added (metered, so nothing is charged until minutes are used).
// Then set STRIPE_AI_PHONE_METER_EVENT=ai_phone_minutes on the Worker.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FOUNDING_PLANS, PUBLIC_PLANS } from '../worker/src/plans.mjs';

export const METER_EVENT = 'ai_phone_minutes';
export const PRODUCT_ID = 'shopcrank_ai_phone_overage';
export const LOOKUP_PREFIX = 'shopcrank_ai_phone_overage_';

export function lookupKey(cents, stripeInterval) {
  return `${LOOKUP_PREFIX}${cents}c_${stripeInterval}`;
}

/** Every per-minute overage rate any plan uses (Solo 15¢, Shop 12¢, Shop Pro 10¢, Enterprise 8¢). */
export function overageRates() {
  return [...new Set([...PUBLIC_PLANS, ...FOUNDING_PLANS].map(plan => Number(plan.overageCents)).filter(Boolean))].sort((a, b) => b - a);
}

export function planOverageCents(planId) {
  return [...PUBLIC_PLANS, ...FOUNDING_PLANS].find(plan => plan.id === planId)?.overageCents || null;
}

/** Runs `stripe <args>` and returns parsed JSON; a Stripe error comes back as { error }. */
export function cliRunner({ live = false } = {}) {
  const exec = args => {
    // The Stripe CLI is a developer tool found on the operator's own PATH (or STRIPE_CLI).
    const cli = process.env.STRIPE_CLI || (process.platform === 'win32' ? 'stripe.exe' : 'stripe');
    if (process.platform !== 'win32' || process.env.STRIPE_CLI) return execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); // NOSONAR operator-run CLI script
    try {
      return execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); // NOSONAR operator-run CLI script
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // npm installs a stripe.cmd shim, which needs cmd.exe: quote every argument.
      const quoted = args.map(arg => `"${String(arg).replaceAll('"', '""')}"`).join(' ');
      return execFileSync(`stripe ${quoted}`, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  };
  return (args) => {
    let output;
    try {
      output = exec([...args, ...(live ? ['--live', '--confirm'] : [])]);
    } catch (error) {
      output = String(error.stdout || '');
      if (!output.trim()) throw new Error(`stripe ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
    }
    try { return JSON.parse(output); } catch { throw new Error(`stripe ${args.slice(0, 2).join(' ')} did not return JSON: ${output.slice(0, 200)}`); }
  };
}

const data = pairs => Object.entries(pairs).flatMap(([key, value]) => ['-d', `${key}=${value}`]);

function check(result, what) {
  if (result?.error) throw new Error(`${what}: ${result.error.message || JSON.stringify(result.error)}`);
  return result;
}

export function ensureMeter(stripe, log = console.log) {
  const meters = check(stripe(['get', '/v1/billing/meters', ...data({ limit: 100 })]), 'listing meters');
  const existing = (meters.data || []).find(meter => meter.event_name === METER_EVENT && meter.status !== 'inactive');
  if (existing) {
    log(`Meter: ${existing.id} (already there)`);
    return existing.id;
  }
  const created = check(stripe(['post', '/v1/billing/meters', ...data({
    display_name: 'AI phone minutes',
    event_name: METER_EVENT,
    'default_aggregation[formula]': 'sum',
    'customer_mapping[event_payload_key]': 'stripe_customer_id',
    'customer_mapping[type]': 'by_id',
    'value_settings[event_payload_key]': 'value',
  })]), 'creating the meter');
  log(`Meter: ${created.id} (created)`);
  return created.id;
}

export function ensureProduct(stripe, log = console.log) {
  const existing = stripe(['get', `/v1/products/${PRODUCT_ID}`]);
  if (existing?.id === PRODUCT_ID) {
    log(`Product: ${PRODUCT_ID} (already there)`);
    return PRODUCT_ID;
  }
  check(stripe(['post', '/v1/products', ...data({
    id: PRODUCT_ID,
    name: 'AI phone minutes over plan',
    description: 'ShopCrank AI phone agent minutes beyond the plan\'s included minutes, billed per minute.',
    'metadata[shopcrank]': 'ai_phone_overage',
  })]), 'creating the product');
  log(`Product: ${PRODUCT_ID} (created)`);
  return PRODUCT_ID;
}

/** One metered price per rate and interval; returns { key: priceId }. */
export function ensurePrices(stripe, meterId, log = console.log) {
  const prices = {};
  for (const cents of overageRates()) {
    for (const interval of ['month', 'year']) {
      const key = lookupKey(cents, interval);
      const found = check(stripe(['get', '/v1/prices', ...data({ 'lookup_keys[]': key, active: 'true' })]), `looking up ${key}`);
      const existing = (found.data || []).find(price => price.lookup_key === key);
      if (existing && existing.recurring?.meter === meterId) {
        prices[key] = existing.id;
        log(`Price ${key}: ${existing.id} (already there)`);
        continue;
      }
      const created = check(stripe(['post', '/v1/prices', ...data({
        currency: 'usd',
        unit_amount: cents,
        product: PRODUCT_ID,
        nickname: `AI phone overage ${cents}¢/min (${interval}ly bill)`,
        'recurring[interval]': interval,
        'recurring[usage_type]': 'metered',
        'recurring[meter]': meterId,
        lookup_key: key,
        // Moves the key off an older price tied to a different meter.
        transfer_lookup_key: 'true',
      })]), `creating ${key}`);
      prices[key] = created.id;
      log(`Price ${key}: ${created.id} (created)`);
    }
  }
  return prices;
}

/** The overage price a subscription should carry, or null when it has no ShopCrank plan. */
function overagePriceFor(subscription, prices) {
  const items = subscription.items?.data || [];
  const cents = planOverageCents(subscription.metadata?.planId || '');
  if (!cents) return null;
  const interval = items.find(item => item.price?.recurring?.usage_type !== 'metered')?.price?.recurring?.interval;
  return prices[lookupKey(cents, interval === 'year' ? 'year' : 'month')] || null;
}

function hasOveragePrice(subscription) {
  return (subscription.items?.data || []).some(item => String(item.price?.lookup_key || '').startsWith(LOOKUP_PREFIX));
}

function reviewSubscription(stripe, subscription, prices, report, { apply, log }) {
  report.checked += 1;
  if (hasOveragePrice(subscription)) return;
  const planId = subscription.metadata?.planId || '';
  const priceId = overagePriceFor(subscription, prices);
  if (!priceId) {
    report.skipped.push(`${subscription.id} (plan "${planId || 'unknown'}")`);
    return;
  }
  if (!apply) {
    report.wouldAdd.push(`${subscription.id} → ${priceId}`);
    return;
  }
  check(stripe(['post', '/v1/subscription_items', ...data({ subscription: subscription.id, price: priceId, proration_behavior: 'none' })]), `adding overage to ${subscription.id}`);
  report.added.push(subscription.id);
  log(`Added overage to ${subscription.id} (${planId})`);
}

/** Subscriptions that should carry the overage price and don't; adds it when apply is true. */
export function attachToSubscriptions(stripe, prices, { apply = false, log = console.log } = {}) {
  const report = { checked: 0, added: [], wouldAdd: [], skipped: [] };
  for (const status of ['active', 'trialing', 'past_due']) {
    let startingAfter = '';
    for (;;) {
      const query = { status, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) };
      const page = check(stripe(['get', '/v1/subscriptions', ...data(query)]), 'listing subscriptions');
      for (const subscription of page.data || []) reviewSubscription(stripe, subscription, prices, report, { apply, log });
      if (!page.has_more || !page.data?.length) break;
      startingAfter = page.data.at(-1).id;
    }
  }
  return report;
}

export function main(argv = process.argv.slice(2), { stripe = null, log = console.log } = {}) {
  const live = argv.includes('--live');
  const apply = argv.includes('--apply');
  const run = stripe || cliRunner({ live });
  log(`Stripe ${live ? 'LIVE' : 'test'} mode`);
  const meterId = ensureMeter(run, log);
  ensureProduct(run, log);
  const prices = ensurePrices(run, meterId, log);
  const report = attachToSubscriptions(run, prices, { apply, log });
  log(`Subscriptions checked: ${report.checked}; overage added: ${report.added.length}; would add: ${report.wouldAdd.length}; skipped (no ShopCrank plan): ${report.skipped.length}`);
  for (const line of report.wouldAdd) log(`  would add ${line}`);
  for (const line of report.skipped) log(`  skipped ${line}`);
  if (report.wouldAdd.length) log('Run again with --apply to add the overage price to those subscriptions.');
  log(`\nNext: set the Worker variable STRIPE_AI_PHONE_METER_EVENT=${METER_EVENT} (Cloudflare → Workers → shopcrank-api → Settings → Variables).`);
  return { meterId, prices, report };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    if (/ENOENT|not recognized|not found/i.test(error.message)) console.error('Install the Stripe CLI and run `stripe login` first: https://docs.stripe.com/stripe-cli');
    process.exit(1);
  }
}
