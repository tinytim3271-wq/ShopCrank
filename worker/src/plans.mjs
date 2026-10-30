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

export const FEATURE_FLAG_KEYS = Object.freeze([
  'inspections',
  'smartJobs',
  'inventory',
  'digitalAuthorization',
  'invoicing',
  'laborGuide',
  'maintenanceSchedules',
  'timeClocks',
  'reports',
  'twoWayTexting',
  'liveDashboard',
  'techBoard',
  'analytics',
  'integratedPayments',
  'accountManager',
  'estimates',
  'reminders',
  'partsOrdering',
  'mobileApp',
  'unlimitedInspections',
  'motorLabor',
  'alldata',
  'qbo',
  'motorDiagrams',
  'coupons',
  'estimateFollowUps',
  'reviews',
  'workBoard',
  'carfax',
  'cannedJobs',
  'eSign',
  'standardInspections',
  'nextGenInspections',
  'googleReviews',
  'app',
  'aiReceptionist',
  // Backward-compatible keys used elsewhere in the worker/tests.
  'laborGuides',
  'sms',
  'quickbooks',
  'liveDiagnostics',
  'multiLocation',
  'support',
]);

const ENTITLEMENT_FALSE = Object.freeze(
  FEATURE_FLAG_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {}),
);

const METADATA_PASSTHROUGH_FIELDS = Object.freeze([
  'migrationFee',
  'cardReader',
  'cardReaderMonthly',
  'setupFee',
  'leaseBased',
  'quoteBased',
]);

const LEGACY_PRO_ALIASES = Object.freeze({
  pro: 'shop_pro',
  professional: 'shop_pro',
});

const PLAN_ID_ALIASES = Object.freeze({
  'shop-pro': 'shop_pro',
  'shop pro': 'shop_pro',
  'top-tier': 'top_tier',
  'top tier': 'top_tier',
});

const PLAN_FAMILY_ALIASES = Object.freeze({
  growth: 'growth_suite',
  launch: 'growth_suite',
  starter: 'growth_suite',
  schedule: 'growth_suite',
  growth_suite: 'growth_suite',
  clever: 'intelligence_suite',
  mitchell: 'intelligence_suite',
  mitchell1: 'intelligence_suite',
  intelligence: 'intelligence_suite',
  intelligence_suite: 'intelligence_suite',
  essentials: 'ops_suite',
  operations: 'ops_suite',
  ops: 'ops_suite',
  ops_suite: 'ops_suite',
  shopcrank: 'shopcrank',
  legacy: 'shopcrank',
  default: 'shopcrank',
});

const PLAN_FAMILY_ALLOWED_PLANS = Object.freeze({
  growth_suite: new Set(['start', 'grow', 'scale', 'top_tier']),
  intelligence_suite: new Set(['basic', 'clever', 'genius']),
  ops_suite: new Set(['essentials', 'pro', 'elite', 'enterprise']),
  shopcrank: new Set(['solo', 'shop', 'shop_pro', 'enterprise', 'founding_solo', 'founding_shop', 'founding_pro', 'starter', 'growth']),
});

const CORE_CAPABILITIES = Object.freeze([
  'inspections',
  'smart_jobs',
  'inventory',
  'digital_authorization',
  'invoicing',
  'labor_guide',
  'labor_guides',
  'maintenance_schedules',
  'time_clocks',
  'reports',
]);

const GROWTH_CAPABILITIES = Object.freeze([
  ...CORE_CAPABILITIES,
  'two_way_texting',
  'live_dashboard',
  'tech_board',
  'analytics',
  'integrated_payments',
  'estimates',
  'reminders',
  'parts_ordering',
  'mobile_app',
  'work_board',
  'standard_inspections',
  'app',
  'qbo',
  // Backward compatibility capability names.
  'sms',
  'quickbooks',
]);

const SCALE_CAPABILITIES = Object.freeze([
  ...GROWTH_CAPABILITIES,
  'unlimited_inspections',
  'motor_labor',
  'alldata',
  'motor_diagrams',
  'coupons',
  'estimate_follow_ups',
  'reviews',
  'carfax',
  'canned_jobs',
  'e_sign',
  'next_gen_inspections',
  'live_diagnostics',
]);

const ENTERPRISE_CAPABILITIES = Object.freeze([
  ...SCALE_CAPABILITIES,
  'google_reviews',
  'account_manager',
  'ai_receptionist',
  'multi_location',
  'support',
]);

export const PLAN_CAPABILITIES = Object.freeze({
  // Legacy/public catalog
  solo: [...CORE_CAPABILITIES, 'parts_ordering', 'support', 'app', 'sms', 'two_way_texting'],
  shop: [...GROWTH_CAPABILITIES, 'support'],
  shop_pro: [...SCALE_CAPABILITIES, 'support'],
  enterprise: [...ENTERPRISE_CAPABILITIES],
  founding_solo: [...CORE_CAPABILITIES, 'parts_ordering', 'support', 'app', 'sms', 'two_way_texting'],
  founding_shop: [...GROWTH_CAPABILITIES, 'support'],
  founding_pro: [...SCALE_CAPABILITIES, 'support'],
  starter: [...CORE_CAPABILITIES, 'parts_ordering', 'support', 'app'],
  growth: [...GROWTH_CAPABILITIES, 'support'],

  // Schedule families
  start: [...CORE_CAPABILITIES, 'parts_ordering', 'standard_inspections', 'app'],
  grow: [...GROWTH_CAPABILITIES],
  scale: [...SCALE_CAPABILITIES],
  top_tier: [...ENTERPRISE_CAPABILITIES],

  basic: [...CORE_CAPABILITIES, 'parts_ordering', 'standard_inspections', 'app'],
  clever: [...GROWTH_CAPABILITIES],
  genius: [...ENTERPRISE_CAPABILITIES],

  essentials: [...CORE_CAPABILITIES, 'parts_ordering', 'standard_inspections', 'app'],
  pro: [...GROWTH_CAPABILITIES],
  elite: [...SCALE_CAPABILITIES],
});

const ADDON_ALIASES = Object.freeze({
  'multi-shop': 'multi_shop',
  multishop: 'multi_shop',
  'multi-location': 'multi_shop',
  multilocation: 'multi_shop',
  'extra-user': 'extra_users',
  'extra-users': 'extra_users',
  extrauser: 'extra_users',
  extrausers: 'extra_users',
  'ai-receptionist': 'ai_receptionist',
  aireceptionist: 'ai_receptionist',
});

function toSnakeCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

function canonicalFamilyId(value) {
  const normalized = toSnakeCase(value);
  return PLAN_FAMILY_ALIASES[normalized] || normalized;
}

function canonicalPlanId(value, { allowLegacyProAlias = true } = {}) {
  const normalized = toSnakeCase(value);
  if (allowLegacyProAlias && LEGACY_PRO_ALIASES[normalized]) return LEGACY_PRO_ALIASES[normalized];
  return PLAN_ID_ALIASES[normalized] || normalized;
}

function normalizeAddonToken(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return '';
  const [name, count] = raw.split(/[:=]/, 2);
  const normalizedName = ADDON_ALIASES[name] || toSnakeCase(name);
  return count ? `${normalizedName}:${count}` : normalizedName;
}

function collectAddonTokens(subscription, planAddons = []) {
  const tokens = [...planAddons];
  const pushFrom = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const token of value) pushFrom(token);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled === true) tokens.push(String(key));
        else if (typeof enabled === 'number' && Number.isFinite(enabled) && enabled > 0) {
          tokens.push(`${key}:${enabled}`);
        }
      }
      return;
    }
    const text = String(value).trim();
    if (!text) return;
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        pushFrom(JSON.parse(text));
        return;
      } catch {
        // Continue as a plain string token list.
      }
    }
    for (const token of text.split(/[,+;|]/)) tokens.push(token);
  };

  pushFrom(subscription?.addons);
  pushFrom(subscription?.addon_codes);
  pushFrom(subscription?.add_on_codes);
  pushFrom(subscription?.features);
  pushFrom(subscription?.metadata?.addons);
  pushFrom(subscription?.metadata?.features);

  return tokens.map(normalizeAddonToken).filter(Boolean);
}

function parsePlanAndFamily(planId) {
  const raw = String(planId || '').trim();
  if (!raw) return { family: 'unknown', canonicalFamily: 'unknown', basePlanId: '', planAddons: [] };

  const [planRef, ...planAddonTokens] = raw.split('+');
  const [maybeFamily, maybePlan] = planRef.split(/[:/]/, 2);
  const hasFamilyPrefix = Boolean(maybePlan);
  const family = hasFamilyPrefix ? toSnakeCase(maybeFamily) : 'shopcrank';
  const canonicalFamily = hasFamilyPrefix ? canonicalFamilyId(maybeFamily) : 'shopcrank';
  const planToken = hasFamilyPrefix ? maybePlan : maybeFamily;
  const allowLegacyProAlias = !hasFamilyPrefix;

  return {
    family,
    canonicalFamily,
    basePlanId: canonicalFamily === 'growth_suite' && toSnakeCase(planToken) === 'starter'
      ? 'start'
      : canonicalPlanId(planToken, { allowLegacyProAlias }),
    planAddons: planAddonTokens.map(normalizeAddonToken).filter(Boolean),
  };
}

function capabilitiesToFeatures(capabilities) {
  const capabilitySet = new Set(capabilities || []);
  const hasAny = (...caps) => caps.some(cap => capabilitySet.has(cap));

  const features = {
    ...ENTITLEMENT_FALSE,
    inspections: hasAny('inspections', 'standard_inspections', 'next_gen_inspections', 'unlimited_inspections'),
    smartJobs: capabilitySet.has('smart_jobs'),
    inventory: capabilitySet.has('inventory'),
    digitalAuthorization: capabilitySet.has('digital_authorization'),
    invoicing: capabilitySet.has('invoicing'),
    laborGuide: hasAny('labor_guide', 'labor_guides'),
    maintenanceSchedules: capabilitySet.has('maintenance_schedules'),
    timeClocks: capabilitySet.has('time_clocks'),
    reports: capabilitySet.has('reports'),
    twoWayTexting: hasAny('two_way_texting', 'sms'),
    liveDashboard: capabilitySet.has('live_dashboard'),
    techBoard: capabilitySet.has('tech_board'),
    analytics: capabilitySet.has('analytics'),
    integratedPayments: capabilitySet.has('integrated_payments'),
    accountManager: capabilitySet.has('account_manager'),
    estimates: capabilitySet.has('estimates'),
    reminders: capabilitySet.has('reminders'),
    partsOrdering: capabilitySet.has('parts_ordering'),
    mobileApp: capabilitySet.has('mobile_app'),
    unlimitedInspections: capabilitySet.has('unlimited_inspections'),
    motorLabor: capabilitySet.has('motor_labor'),
    alldata: capabilitySet.has('alldata'),
    qbo: hasAny('qbo', 'quickbooks'),
    motorDiagrams: capabilitySet.has('motor_diagrams'),
    coupons: capabilitySet.has('coupons'),
    estimateFollowUps: capabilitySet.has('estimate_follow_ups'),
    reviews: capabilitySet.has('reviews'),
    workBoard: capabilitySet.has('work_board'),
    carfax: capabilitySet.has('carfax'),
    cannedJobs: capabilitySet.has('canned_jobs'),
    eSign: capabilitySet.has('e_sign'),
    standardInspections: capabilitySet.has('standard_inspections'),
    nextGenInspections: capabilitySet.has('next_gen_inspections'),
    googleReviews: capabilitySet.has('google_reviews'),
    app: capabilitySet.has('app'),
    aiReceptionist: capabilitySet.has('ai_receptionist'),
    laborGuides: hasAny('labor_guides', 'labor_guide'),
    sms: hasAny('sms', 'two_way_texting'),
    quickbooks: hasAny('quickbooks', 'qbo'),
    liveDiagnostics: hasAny('live_diagnostics', 'motor_labor', 'alldata', 'motor_diagrams'),
    multiLocation: capabilitySet.has('multi_location'),
    support: capabilitySet.has('support'),
  };

  return features;
}

function planAllowedInFamily(basePlanId, canonicalFamily) {
  const allowed = PLAN_FAMILY_ALLOWED_PLANS[canonicalFamily];
  return Boolean(allowed?.has(basePlanId));
}

export function planCapabilities(planId) {
  const raw = String(planId || '').trim();
  if (!raw) return [];

  // Direct plan lookups should remain family-agnostic for internal callers.
  if (!/[/:]/.test(raw.split('+')[0])) {
    const basePlanId = canonicalPlanId(raw.split('+')[0]);
    return [...(PLAN_CAPABILITIES[basePlanId] || [])];
  }

  const { canonicalFamily, basePlanId } = parsePlanAndFamily(raw);
  if (!planAllowedInFamily(basePlanId, canonicalFamily)) return [];
  return [...(PLAN_CAPABILITIES[basePlanId] || [])];
}

function pickMetadataValue(subscription, field) {
  const snake = toSnakeCase(field);
  return subscription?.metadata?.[field]
    ?? subscription?.metadata?.[snake]
    ?? subscription?.[field]
    ?? subscription?.[snake];
}

function passthroughMetadata(subscription) {
  const metadata = {};
  for (const field of METADATA_PASSTHROUGH_FIELDS) {
    const value = pickMetadataValue(subscription, field);
    if (value !== undefined && value !== null && value !== '') metadata[field] = value;
  }
  return metadata;
}

export function resolveSubscriptionEntitlements(subscription = null) {
  const planId = String(subscription?.plan_id || '').trim();
  const {
    family,
    canonicalFamily,
    basePlanId,
    planAddons,
  } = parsePlanAndFamily(planId);

  const capabilities = planAllowedInFamily(basePlanId, canonicalFamily)
    ? [...(PLAN_CAPABILITIES[basePlanId] || [])]
    : [];

  const features = capabilities.length ? capabilitiesToFeatures(capabilities) : { ...ENTITLEMENT_FALSE };
  const addOns = {
    multiShop: false,
    multiShopCount: 0,
    extraUsers: 0,
    aiReceptionist: false,
    ...passthroughMetadata(subscription),
  };

  for (const token of collectAddonTokens(subscription, planAddons)) {
    if (token === 'multi_shop' || token.startsWith('multi_shop:')) {
      const quantity = Number.parseInt(token.split(':')[1] || '1', 10);
      const count = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      addOns.multiShop = true;
      addOns.multiShopCount += count;
      features.multiLocation = true;
      continue;
    }
    if (token === 'ai_receptionist') {
      addOns.aiReceptionist = true;
      features.aiReceptionist = true;
      continue;
    }
    if (token.startsWith('extra_users')) {
      const quantity = Number.parseInt(token.split(':')[1] || '1', 10);
      if (Number.isFinite(quantity) && quantity > 0) addOns.extraUsers += quantity;
    }
  }

  // Preserve backward compatibility when old capability names exist.
  if (features.qbo) features.quickbooks = true;
  if (features.twoWayTexting) features.sms = true;
  if (features.laborGuide) features.laborGuides = true;

  return {
    planId,
    family,
    canonicalFamily,
    basePlanId,
    knownPlan: capabilities.length > 0,
    capabilities,
    features,
    addOns,
  };
}

/** Active or trialing, and the paid period / trial has not ended. */
export function subscriptionActive(subscription, now = Date.now()) {
  const periodEnd = subscription?.current_period_end
    ? Date.parse(subscription.current_period_end)
    : null;
  return ['active', 'trialing'].includes(String(subscription?.status || ''))
    && (periodEnd === null || (Number.isFinite(periodEnd) && periodEnd > now));
}

export function hasPlanCapability(subscription, capability, now = Date.now()) {
  return subscriptionActive(subscription, now) && planCapabilities(subscription?.plan_id).includes(capability);
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
