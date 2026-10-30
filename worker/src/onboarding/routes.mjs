// /api/onboarding/*. Operators (platform super_admin) run onboarding; a shop's
// own admins can read their progress at /api/onboarding/self.

import { HttpError, json, requestJson } from '../http.mjs';
import { createOnboarding, getOnboarding, listOnboardingEvents, listOnboardings, listPendingA2pOnboardings, recordOnboardingEvent, saveOnboarding } from './store.mjs';
import { validateIntake } from './intake.mjs';
import { STEP_BY_ID } from './timeline.mjs';
import {
  approveStep,
  checkTestCall,
  executeStep,
  onboardingSummary,
  pollA2pStatus,
  previewStep,
  searchNumbers,
  selectNumber,
} from './service.mjs';
import { OnboardingBlockedError } from './twilio-executor.mjs';

const SHOP_VIEW_ROLES = ['owner', 'admin'];

function asHttp(error) {
  if (error instanceof OnboardingBlockedError) return new HttpError(409, error.message);
  return error;
}

async function requireOnboarding(env, shopId) {
  const onboarding = await getOnboarding(env, shopId);
  if (!onboarding) throw new HttpError(404, 'No onboarding record for this shop');
  return onboarding;
}

export async function handleOnboardingRoutes(request, env, context, segments, { getSecret, saveSecret, fetcher = fetch }) {
  const actor = context.email || context.userId || 'operator';
  const [, first = '', second = '', third = '', fourth = ''] = segments.map(segment => decodeURIComponent(segment));

  if (first === 'self') {
    if (!SHOP_VIEW_ROLES.includes(context.role)) throw new HttpError(403, 'Only shop owners and admins can view onboarding progress');
    const onboarding = await getOnboarding(env, context.shopId);
    if (!onboarding) return json({ onboarding: null });
    const summary = await onboardingSummary(env, onboarding, { getSecret });
    return json({ onboarding: { shopId: summary.shopId, status: summary.status, checklist: summary.checklist, facts: summary.facts, phoneLive: summary.phoneLive, smsLive: summary.smsLive } });
  }

  if (context.role !== 'super_admin') throw new HttpError(403, 'Onboarding is run by ShopCrank operators');

  try {
    if (!first) {
      if (request.method === 'GET') {
        const all = await listOnboardings(env);
        return json({ onboardings: await Promise.all(all.map(item => onboardingSummary(env, item, { getSecret }))) });
      }
      if (request.method === 'POST') {
        const body = await requestJson(request);
        const { valid, errors, intake } = validateIntake(body.intake || body);
        if (!intake.shopId) throw new HttpError(400, 'A shop ID (tenant slug) is required');
        if (await getOnboarding(env, intake.shopId)) throw new HttpError(409, 'Onboarding already exists for this shop');
        const onboarding = await createOnboarding(env, { shopId: intake.shopId, intake, actor });
        await recordOnboardingEvent(env, { shopId: intake.shopId, step: 'intake', kind: 'created', detail: { valid, errorCount: errors.length }, actor });
        return json({ onboarding: await onboardingSummary(env, onboarding, { getSecret }), validation: { valid, errors } }, 201);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const onboarding = await requireOnboarding(env, first);

    if (!second && request.method === 'GET') {
      const [summary, events] = await Promise.all([onboardingSummary(env, onboarding, { getSecret }), listOnboardingEvents(env, onboarding.shopId)]);
      return json({ onboarding: summary, events, validation: validateIntake(onboarding.intake) });
    }

    if (second === 'intake' && request.method === 'PUT') {
      const body = await requestJson(request);
      const { valid, errors, intake } = validateIntake({ ...onboarding.intake, ...(body.intake || body), shopId: onboarding.shopId });
      onboarding.intake = intake;
      await saveOnboarding(env, onboarding);
      await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: 'intake', kind: 'updated', detail: { valid }, actor });
      return json({ onboarding: await onboardingSummary(env, onboarding, { getSecret }), validation: { valid, errors } });
    }

    if (second === 'steps' && third && STEP_BY_ID[third]) {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await requestJson(request).catch(() => ({}));
      if (fourth === 'plan') return json(await previewStep(env, onboarding, third, { getSecret, actor }));
      if (fourth === 'approve') {
        if (body.confirm !== 'APPROVE') throw new HttpError(400, 'Type APPROVE to confirm');
        return json({ approval: await approveStep(env, onboarding, third, { planHash: body.planHash, actor, getSecret }) });
      }
      if (fourth === 'execute') {
        const mode = body.mode === 'live' ? 'live' : 'dry_run';
        return json(await executeStep(env, onboarding, third, { mode, actor, getSecret, saveSecret, fetcher }));
      }
      if (fourth === 'mark') {
        if (!['manual', 'auto'].includes(STEP_BY_ID[third].kind) && body.status !== 'pending') throw new HttpError(409, 'Only manual or self-checking steps can be marked by hand');
        const status = ['done', 'skipped', 'pending'].includes(body.status) ? body.status : 'done';
        onboarding.state.steps[third] = { ...(onboarding.state.steps[third] || {}), status, completedAt: status === 'done' ? new Date().toISOString() : null, note: String(body.note || '').slice(0, 500) };
        await saveOnboarding(env, onboarding);
        await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: third, kind: `marked_${status}`, detail: { note: body.note || '' }, actor });
        return json({ onboarding: await onboardingSummary(env, onboarding, { getSecret }) });
      }
    }

    if (second === 'twilio' && third === 'search' && request.method === 'POST') {
      const body = await requestJson(request).catch(() => ({}));
      return json(await searchNumbers(env, onboarding, { mode: body.mode === 'live' ? 'live' : 'dry_run', getSecret, fetcher, actor }));
    }
    if (second === 'twilio' && third === 'select' && request.method === 'POST') {
      const body = await requestJson(request);
      return json(await selectNumber(env, onboarding, String(body.phoneNumber || '')));
    }
    if (second === 'a2p' && third === 'poll' && request.method === 'POST') {
      const body = await requestJson(request).catch(() => ({}));
      return json(await pollA2pStatus(env, onboarding, { mode: body.mode === 'live' ? 'live' : 'dry_run', getSecret, fetcher }));
    }
    if (second === 'test-call' && third === 'check' && request.method === 'POST') {
      const body = await requestJson(request).catch(() => ({}));
      return json(await checkTestCall(env, onboarding, { mode: body.mode === 'live' ? 'live' : 'dry_run', getSecret, fetcher }));
    }
  } catch (error) {
    throw asHttp(error);
  }
  throw new HttpError(404, 'Not found');
}

/** Cron: poll A2P status for shops with submissions in flight (live mode only). */
export async function pollPendingA2p(env, { getSecret, fetcher = fetch } = {}) {
  if (String(env?.ONBOARDING_LIVE_MODE || '') !== '1' || !env?.DB) return [];
  const results = [];
  for (const onboarding of await listPendingA2pOnboardings(env)) {
    const a2p = onboarding.state.a2p || {};
    try {
      const outcome = await pollA2pStatus(env, onboarding, { mode: 'live', getSecret, fetcher });
      results.push({ shopId: onboarding.shopId, changed: outcome.changed?.length || 0 });
    } catch (error) {
      results.push({ shopId: onboarding.shopId, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return results;
}
