// AI phone agent metering: every plan includes a monthly bucket of AI phone
// minutes (plans.mjs aiPhoneMinutes). Calls past the bucket keep being answered
// and are billed at the plan's overage rate, unless the shop set a spending cap.

import { HttpError, json } from './http.mjs';
import { providerBase } from './provider-base.mjs';
import { planById, subscriptionActive } from './plans.mjs';
import { getShopSetting, putShopSetting } from './shop-settings-store.mjs';
import { getOnboarding } from './onboarding/store.mjs';
import { normalizeQuestionnaireAnswers } from '../../src/modules/front-desk-questionnaire.js';

/** ai_usage_events.user_id values that are AI phone calls (Grok over Twilio, AgentPhone). */
export const PHONE_AGENT_USER_IDS = Object.freeze(['grok-phone-receptionist', 'agentphone-call']);
export const PHONE_BILLING_SETTING = 'ai-phone-billing';

// Older plan ids still on some subscriptions; they get the closest current bucket.
const PLAN_ALLOWANCE_ALIASES = Object.freeze({
  starter: 'solo', start: 'solo', basic: 'solo', essentials: 'solo',
  growth: 'shop', grow: 'shop', clever: 'shop',
  pro: 'shop_pro', professional: 'shop_pro', scale: 'shop_pro', elite: 'shop_pro',
  top_tier: 'enterprise', genius: 'enterprise',
});

/** Included minutes and overage rate for a plan id (unknown ids get the Solo bucket). */
export function phoneAllowance(planId) {
  const id = String(planId || '').trim().toLowerCase();
  const plan = planById(id) || planById(PLAN_ALLOWANCE_ALIASES[id]) || planById('solo');
  return {
    planId: id || plan.id,
    planName: plan.name,
    includedMinutes: Number(plan.aiPhoneMinutes) || 0,
    overageRateCents: Number(plan.overageCents) || 0,
  };
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/**
 * The monthly window minutes are counted in. Anchored on the Stripe period start
 * (or the subscription's start); without either, the calendar month (UTC).
 */
export function phoneBillingPeriod(subscription, now = Date.now()) {
  const current = new Date(now);
  const anchorValue = subscription?.current_period_start || subscription?.created_at || '';
  const anchor = new Date(Date.parse(anchorValue));
  if (!Number.isFinite(anchor.getTime()) || anchor.getTime() > current.getTime()) {
    const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
    return { start: start.toISOString(), end: addMonths(start, 1).toISOString() };
  }
  let months = (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + current.getUTCMonth() - anchor.getUTCMonth();
  if (addMonths(anchor, months).getTime() > current.getTime()) months -= 1;
  const start = addMonths(anchor, Math.max(0, months));
  return { start: start.toISOString(), end: addMonths(anchor, Math.max(0, months) + 1).toISOString() };
}

/** Each call is rounded up to the next whole minute, like a phone bill. */
export function billableMinutes(seconds) {
  const value = Number(seconds) || 0;
  return value > 0 ? Math.ceil(value / 60) : 0;
}

async function loadSubscription(env, shopId) {
  return env.DB.prepare(
    'SELECT plan_id, status, current_period_start, current_period_end, created_at FROM subscriptions WHERE shop_id = ? LIMIT 1',
  ).bind(shopId).first();
}

async function minutesUsed(env, shopId, start, end) {
  const placeholders = PHONE_AGENT_USER_IDS.map(() => '?').join(', ');
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN voice_seconds > 0 THEN (CAST(voice_seconds AS INTEGER) + 59) / 60 ELSE 0 END), 0) AS minutes
    FROM ai_usage_events
    WHERE shop_id = ? AND user_id IN (${placeholders}) AND created_at >= ? AND created_at < ?
  `).bind(shopId, ...PHONE_AGENT_USER_IDS, start, end).first();
  return { calls: Number(row?.calls) || 0, minutes: Number(row?.minutes) || 0 };
}

function normalizeCap(value) {
  if (value === null || value === undefined || value === '') return null;
  const cents = Math.round(Number(value));
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

/** Where callers go when the AI cannot take the call: a Front Desk transfer number, else the shop's own line. */
export async function shopFallbackPhone(env, shopId) {
  const valid = phone => /^\+[1-9]\d{7,14}$/.test(String(phone || '').trim());
  const setting = await getShopSetting(env, shopId, 'front_desk_questionnaire').catch(() => null);
  const target = (normalizeQuestionnaireAnswers(setting?.answers || {}).transferTargets || []).find(item => valid(item.phone));
  if (target) return String(target.phone).trim();
  const onboarding = await getOnboarding(env, shopId).catch(() => null);
  const current = String(onboarding?.intake?.currentPhone || '').trim();
  return valid(current) ? current : '';
}

/** This period's AI phone minutes for a shop, its plan bucket, overage so far and any cap. */
export async function phoneUsageSummary(env, shopId, now = Date.now()) {
  const subscription = await loadSubscription(env, shopId);
  const allowance = phoneAllowance(subscription?.plan_id);
  const period = phoneBillingPeriod(subscription, now);
  const [{ calls, minutes }, setting] = await Promise.all([
    minutesUsed(env, shopId, period.start, period.end),
    getShopSetting(env, shopId, PHONE_BILLING_SETTING).catch(() => null),
  ]);
  const overageMinutes = Math.max(0, minutes - allowance.includedMinutes);
  const overageChargeCents = overageMinutes * allowance.overageRateCents;
  const overageCapCents = normalizeCap(setting?.overageCapCents);
  return {
    ...allowance,
    active: subscriptionActive(subscription, now),
    status: String(subscription?.status || 'none'),
    periodStart: period.start,
    periodEnd: period.end,
    calls,
    usedMinutes: minutes,
    remainingMinutes: Math.max(0, allowance.includedMinutes - minutes),
    percentUsed: allowance.includedMinutes ? Math.round((minutes / allowance.includedMinutes) * 100) : 0,
    overageMinutes,
    overageChargeCents,
    overageCapCents,
    capReached: overageCapCents !== null && overageMinutes > 0 && overageChargeCents >= overageCapCents,
  };
}

/** Whether the AI phone agent may answer a new call right now. */
export async function phoneCallDecision(env, shopId, now = Date.now()) {
  const usage = await phoneUsageSummary(env, shopId, now);
  if (!usage.active) return { allowed: false, reason: 'no_active_plan', usage };
  // A $0 cap means "never go past the included minutes".
  if (usage.overageCapCents === 0 && usage.remainingMinutes === 0) return { allowed: false, reason: 'overage_cap_reached', usage };
  if (usage.capReached) return { allowed: false, reason: 'overage_cap_reached', usage };
  return { allowed: true, reason: usage.remainingMinutes > 0 ? 'included' : 'overage', usage };
}

/**
 * Splits a finished call into included and overage minutes, using the minutes
 * already used this period (read before the call's own usage row is written).
 */
export function splitCallMinutes(usage, seconds) {
  const callMinutes = billableMinutes(seconds);
  const before = Number(usage?.usedMinutes) || 0;
  const included = Number(usage?.includedMinutes) || 0;
  const overageMinutes = Math.max(0, before + callMinutes - included) - Math.max(0, before - included);
  return {
    billableMinutes: callMinutes,
    includedMinutes: callMinutes - overageMinutes,
    overageMinutes,
    overageChargeCents: overageMinutes * (Number(usage?.overageRateCents) || 0),
  };
}

/**
 * Sends a call's overage minutes to a Stripe Billing Meter when one is set up
 * (STRIPE_AI_PHONE_METER_EVENT). The per-minute rate lives on the shop's Stripe price.
 */
export async function reportOverageToStripe(env, shopId, { overageMinutes, callId }, fetcher = fetch) {
  const eventName = String(env.STRIPE_AI_PHONE_METER_EVENT || '').trim();
  const stripeKey = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!overageMinutes || !eventName || !stripeKey) return { reported: false, reason: 'not_configured' };
  const customer = await env.DB.prepare('SELECT stripe_customer_id FROM billing_customers WHERE shop_id = ?').bind(shopId).first();
  if (!customer?.stripe_customer_id) return { reported: false, reason: 'no_stripe_customer' };
  const body = new URLSearchParams({
    event_name: eventName,
    'payload[stripe_customer_id]': customer.stripe_customer_id,
    'payload[value]': String(overageMinutes),
    identifier: `ai-phone-${shopId}-${callId}`.slice(0, 100),
  });
  const response = await fetcher(`${providerBase(env, 'STRIPE', 'https://api.stripe.com/v1')}/billing/meter_events`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) return { reported: false, reason: `stripe_${response.status}` };
  return { reported: true };
}

/** Usage-row fields for a finished AI phone call: minutes split, billed amount, metering metadata. */
export async function meterPhoneCall(env, shopId, { seconds, callId = '' }, fetcher = fetch) {
  let usage = null;
  try {
    usage = await phoneUsageSummary(env, shopId);
  } catch (error) {
    console.error(JSON.stringify({ message: 'AI phone metering could not read usage', shopId, error: String(error?.message || error) }));
    return { billedUsd: null, metering: { error: 'usage_unavailable' } };
  }
  const split = splitCallMinutes(usage, seconds);
  let stripe = { reported: false, reason: 'no_overage' };
  if (split.overageMinutes > 0) {
    stripe = await reportOverageToStripe(env, shopId, { overageMinutes: split.overageMinutes, callId: callId || crypto.randomUUID() }, fetcher)
      .catch(error => ({ reported: false, reason: String(error?.message || error).slice(0, 120) }));
  }
  return {
    billedUsd: split.overageChargeCents / 100,
    metering: {
      planId: usage.planId,
      periodStart: usage.periodStart,
      ...split,
      overageRateCents: usage.overageRateCents,
      stripeReported: stripe.reported,
      ...(stripe.reported ? {} : { stripeReason: stripe.reason }),
    },
  };
}

/** GET (anyone in the shop) / PUT (owner/admin) /api/phone-usage. */
export async function handlePhoneUsage(request, env, context, { requireRole }) {
  if (request.method === 'GET') return json(await phoneUsageSummary(env, context.shopId));
  if (request.method === 'PUT') {
    requireRole(context, ['admin', 'owner', 'super_admin']);
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const raw = body.overageCapCents;
    const cap = raw === null || raw === '' ? null : normalizeCap(raw);
    if (raw !== null && raw !== '' && cap === null) {
      throw new HttpError(400, 'overageCapCents must be a whole number of cents, 0 or more, or null for no cap');
    }
    await putShopSetting(env, context.shopId, PHONE_BILLING_SETTING, { overageCapCents: cap }, context.userId || 'system');
    return json(await phoneUsageSummary(env, context.shopId));
  }
  throw new HttpError(405, 'Method not allowed');
}

/** Stripe lookup key of the metered overage price for a per-minute rate and billing interval. */
export function overageLookupKey(overageCents, interval = 'monthly') {
  const cents = Math.round(Number(overageCents) || 0);
  return `shopcrank_ai_phone_overage_${cents}c_${interval === 'annual' ? 'year' : 'month'}`;
}

/**
 * The metered AI phone overage price for a plan, found by lookup key
 * (scripts/stripe-overage-setup.mjs creates them). Null when overage billing
 * is not set up: checkout then sells the plan alone, as before.
 */
export async function findOveragePrice(env, planId, interval = 'monthly', fetcher = fetch) {
  const stripeKey = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey || !String(env.STRIPE_AI_PHONE_METER_EVENT || '').trim()) return null;
  const { overageRateCents } = phoneAllowance(planId);
  if (!overageRateCents) return null;
  const lookupKey = overageLookupKey(overageRateCents, interval);
  const base = providerBase(env, 'STRIPE', 'https://api.stripe.com/v1');
  try {
    const response = await fetcher(`${base}/prices?active=true&lookup_keys[]=${encodeURIComponent(lookupKey)}`, {
      headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}` },
    });
    const payload = await response.json().catch(() => ({}));
    const price = (payload.data || []).find(item => item.lookup_key === lookupKey && item.recurring?.usage_type === 'metered');
    if (!price) console.warn(JSON.stringify({ message: 'AI phone overage price not found; checkout continues without it', lookupKey }));
    return price?.id || null;
  } catch (error) {
    console.warn(JSON.stringify({ message: 'AI phone overage price lookup failed', lookupKey, error: String(error?.message || error) }));
    return null;
  }
}
