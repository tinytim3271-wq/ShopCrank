/** Commercial catalog. Public prices stay off the founding invite. */

/** Free trial length for public signup and founding claims. */
export const PUBLIC_TRIAL_DAYS = 14;

/** Locked Founding Member scarcity: first N shops keep invite rates. */
export const FOUNDING_MEMBER_CAP = 50;

export const PUBLIC_PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    stripePriceId: 'price_solo',
    stripeMonthlyEnv: 'STRIPE_PRICE_SOLO_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_SOLO_ANNUAL',
    monthlyPriceCents: 6900,
    annualPriceCents: 6900 * 10,
    aiPhoneMinutes: 200,
    overageCents: 15,
    diagnosticsMode: 'simulate',
    maxLocations: 1,
    audience: 'Mobile mechanic',
  },
  {
    id: 'shop',
    name: 'Shop',
    stripePriceId: 'price_shop',
    stripeMonthlyEnv: 'STRIPE_PRICE_SHOP_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_SHOP_ANNUAL',
    monthlyPriceCents: 13900,
    annualPriceCents: 13900 * 10,
    aiPhoneMinutes: 800,
    overageCents: 12,
    diagnosticsMode: 'simulate',
    maxLocations: 1,
    audience: '2–10 person shop',
  },
  {
    id: 'shop_pro',
    name: 'Shop Pro',
    stripePriceId: 'price_shop_pro',
    stripeMonthlyEnv: 'STRIPE_PRICE_SHOP_PRO_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_SHOP_PRO_ANNUAL',
    monthlyPriceCents: 27900,
    annualPriceCents: 27900 * 10,
    aiPhoneMinutes: 2500,
    overageCents: 10,
    diagnosticsMode: 'live',
    maxLocations: 1,
    audience: 'Programming shops',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    stripePriceId: 'price_enterprise',
    stripeMonthlyEnv: 'STRIPE_PRICE_ENTERPRISE_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_ENTERPRISE_ANNUAL',
    monthlyPriceCents: 55900,
    annualPriceCents: 55900 * 10,
    aiPhoneMinutes: 10000,
    overageCents: 8,
    diagnosticsMode: 'live',
    maxLocations: 25,
    audience: 'Chains and fleets',
  },
];

export const FOUNDING_PLANS = [
  {
    id: 'founding_solo',
    name: 'Founding Solo',
    stripePriceId: 'price_founding_solo',
    stripeMonthlyEnv: 'STRIPE_PRICE_FOUNDING_SOLO_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_FOUNDING_SOLO_ANNUAL',
    monthlyPriceCents: 4900,
    annualPriceCents: 4900 * 10,
    aiPhoneMinutes: 200,
    overageCents: 15,
    diagnosticsMode: 'simulate',
    publicPriceCents: 6900,
  },
  {
    id: 'founding_shop',
    name: 'Founding Shop',
    stripePriceId: 'price_founding_shop',
    stripeMonthlyEnv: 'STRIPE_PRICE_FOUNDING_SHOP_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_FOUNDING_SHOP_ANNUAL',
    monthlyPriceCents: 9900,
    annualPriceCents: 9900 * 10,
    aiPhoneMinutes: 800,
    overageCents: 12,
    diagnosticsMode: 'simulate',
    publicPriceCents: 13900,
  },
  {
    id: 'founding_pro',
    name: 'Founding Pro',
    stripePriceId: 'price_founding_pro',
    stripeMonthlyEnv: 'STRIPE_PRICE_FOUNDING_PRO_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_FOUNDING_PRO_ANNUAL',
    monthlyPriceCents: 19900,
    annualPriceCents: 19900 * 10,
    aiPhoneMinutes: 2500,
    overageCents: 10,
    diagnosticsMode: 'live',
    publicPriceCents: 27900,
  },
];

export const LIVE_DIAGNOSTICS_PLANS = new Set(
  [...PUBLIC_PLANS, ...FOUNDING_PLANS].filter(plan => plan.diagnosticsMode === 'live').map(plan => plan.id),
);

const PLACEHOLDER_PREFIXES = ['price_placeholder', 'price_starter', 'price_growth', 'price_solo', 'price_shop', 'price_enterprise', 'price_founding'];

export function isPlaceholderPrice(priceId) {
  const id = String(priceId || '');
  return !id || PLACEHOLDER_PREFIXES.some(prefix => id.startsWith(prefix));
}

export function isFoundingPlan(planId) {
  return FOUNDING_PLANS.some(plan => plan.id === planId);
}

export function isPublicPlan(planId) {
  return PUBLIC_PLANS.some(plan => plan.id === planId);
}

export function planById(planId) {
  return [...PUBLIC_PLANS, ...FOUNDING_PLANS].find(plan => plan.id === planId) || null;
}

export function stripePriceForPlan(env, planId, interval = 'monthly') {
  const plan = planById(planId);
  if (!plan) return '';
  const key = interval === 'annual' ? plan.stripeAnnualEnv : plan.stripeMonthlyEnv;
  const priceId = String(env?.[key] || '').trim();
  return /^price_[A-Za-z0-9]+$/.test(priceId) && !isPlaceholderPrice(priceId) ? priceId : '';
}

// Two-way texting and text-to-pay are on every plan.
export const PLAN_CAPABILITIES = Object.freeze({
  solo: ['labor_guides', 'parts_ordering', 'sms', 'support'],
  shop: ['labor_guides', 'parts_ordering', 'sms', 'quickbooks', 'support'],
  shop_pro: ['labor_guides', 'parts_ordering', 'sms', 'quickbooks', 'live_diagnostics', 'support'],
  enterprise: ['labor_guides', 'parts_ordering', 'sms', 'quickbooks', 'live_diagnostics', 'multi_location', 'support'],
  founding_solo: ['labor_guides', 'parts_ordering', 'sms', 'support'],
  founding_shop: ['labor_guides', 'parts_ordering', 'sms', 'quickbooks', 'support'],
  founding_pro: ['labor_guides', 'parts_ordering', 'sms', 'quickbooks', 'live_diagnostics', 'support'],
});

export function planCapabilities(planId) {
  return [...(PLAN_CAPABILITIES[planId] || [])];
}

export function hasPlanCapability(subscription, capability, now = Date.now()) {
  const periodEnd = subscription?.current_period_end
    ? Date.parse(subscription.current_period_end)
    : null;
  return ['active', 'trialing'].includes(String(subscription?.status || ''))
    && (periodEnd === null || (Number.isFinite(periodEnd) && periodEnd > now))
    && planCapabilities(subscription?.plan_id).includes(capability);
}

export function claimDecision({ invite, counter, planId }) {
  if (!isFoundingPlan(planId)) return { ok: false, status: 400, message: 'Choose a Founding Member plan.' };
  if (!invite) return { ok: false, status: 404, message: 'This invite link is not valid.' };
  if (invite.used_at) return { ok: false, status: 409, message: 'This invite was already used.' };
  const claimed = Number(counter?.claimed || 0);
  const cap = Number(counter?.cap || FOUNDING_MEMBER_CAP);
  if (claimed >= cap) return { ok: false, status: 409, message: 'Founding Member spots are full.' };
  return { ok: true, claimed: claimed + 1, cap, remaining: cap - claimed - 1 };
}

export function dollars(cents) {
  return `$${Math.round(Number(cents) / 100)}`;
}
