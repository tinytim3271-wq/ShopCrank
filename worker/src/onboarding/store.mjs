// Onboarding record per shop: intake answers, per-step state, provisioned
// Twilio/A2P identifiers (never secrets), test-call results, go-live flags.

function parse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function emptyOnboardingState() {
  return { steps: {}, twilio: {}, a2p: {}, testCalls: [], alerts: [], phoneLive: false, smsLive: false };
}

function rowToOnboarding(row) {
  if (!row) return null;
  return {
    shopId: row.shop_id,
    status: row.status,
    intake: parse(row.intake_json, {}),
    state: { ...emptyOnboardingState(), ...parse(row.state_json, {}) },
    startedAt: row.started_at,
    createdBy: row.created_by || '',
    updatedAt: row.updated_at,
  };
}

export async function getOnboarding(env, shopId) {
  if (!env?.DB || !shopId) return null;
  return rowToOnboarding(await env.DB.prepare('SELECT * FROM shop_onboarding WHERE shop_id = ?').bind(shopId).first());
}

export async function listOnboardings(env) {
  const result = await env.DB.prepare('SELECT * FROM shop_onboarding ORDER BY started_at DESC LIMIT 200').all();
  return (result.results || []).map(rowToOnboarding);
}

export async function createOnboarding(env, { shopId, intake, actor, startedAt = new Date().toISOString() }) {
  await env.DB.prepare(`
    INSERT INTO shop_onboarding (shop_id, status, intake_json, state_json, started_at, created_by, updated_at)
    VALUES (?, 'intake', ?, ?, ?, ?, ?)
  `).bind(shopId, JSON.stringify(intake), JSON.stringify(emptyOnboardingState()), startedAt, actor || null, startedAt).run();
  return getOnboarding(env, shopId);
}

export async function saveOnboarding(env, onboarding) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE shop_onboarding SET status = ?, intake_json = ?, state_json = ?, updated_at = ? WHERE shop_id = ?
  `).bind(onboarding.status, JSON.stringify(onboarding.intake), JSON.stringify(onboarding.state), now, onboarding.shopId).run();
  return { ...onboarding, updatedAt: now };
}

export async function recordOnboardingEvent(env, { shopId, step, kind, mode = null, detail = {}, actor = null }) {
  await env.DB.prepare(`
    INSERT INTO onboarding_events (id, shop_id, step, kind, mode, detail_json, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), shopId, step, kind, mode, JSON.stringify(detail).slice(0, 20000), actor, new Date().toISOString()).run();
}

export async function listOnboardingEvents(env, shopId, limit = 100) {
  const result = await env.DB.prepare('SELECT * FROM onboarding_events WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?').bind(shopId, limit).all();
  return (result.results || []).map(row => ({ id: row.id, step: row.step, kind: row.kind, mode: row.mode, detail: parse(row.detail_json, {}), actor: row.actor, createdAt: row.created_at }));
}

/**
 * Calls to a shop that is still onboarding go to the shop's current phone until
 * the operator approves go-live. Shops without an onboarding record (such as
 * Reliable Auto Services) are never gated; test calls from the onboarding test
 * caller always reach the bot.
 */
export async function phoneGoLiveGate(env, shopId, fromNumber = '') {
  let onboarding = null;
  try {
    onboarding = await getOnboarding(env, shopId);
  } catch {
    return { gated: false };
  }
  if (!onboarding || onboarding.state.phoneLive) return { gated: false };
  const testCaller = String(env?.ONBOARDING_TEST_CALLER_NUMBER || '').trim();
  if (testCaller && String(fromNumber || '').trim() === testCaller) return { gated: false, testCall: true };
  return {
    gated: true,
    holdingPhone: String(onboarding.intake.currentPhone || '').trim(),
    shopName: onboarding.intake.dbaName || onboarding.intake.legalName || '',
  };
}
