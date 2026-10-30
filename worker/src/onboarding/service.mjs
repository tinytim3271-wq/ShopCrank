// Onboarding step engine. Gated steps follow plan -> approve -> execute:
//   plan:    always a dry run; returns the exact requests, cost estimate, hash
//   approve: platform operator approves that hash (expires, single use)
//   execute: dry-run unless mode === 'live'; live needs a matching unused
//            approval, and external steps also need ONBOARDING_LIVE_MODE=1

import { TWILIO_SECRET_NAMES } from '../integrations/sms.mjs';
import { PARTSTECH_SECRET_NAME } from '../../../src/modules/partstech.js';
import { QUICKBOOKS_SECRET_NAME } from '../../../src/modules/quickbooks.js';
import { validateQuestionnaire, isE164Phone } from '../../../src/modules/front-desk-questionnaire.js';
import { loadQuestionnaire, mergeIntakeIntoAnswers, regenerateShopPersonas } from '../front-desk/persona-render.mjs';
import { validateIntake } from './intake.mjs';
import { STEP_BY_ID, buildChecklist, overallStatus } from './timeline.mjs';
import { planShopRoles, provisionShopRoles } from './roles.mjs';
import { raiseOnboardingAlert } from './alerts.mjs';
import { recordOnboardingEvent, saveOnboarding } from './store.mjs';
import { claimExecution, checkpointExecution } from './executions.mjs';
import {
  ESTIMATED_COSTS,
  describePlan,
  planA2pBrand,
  planA2pCampaign,
  planA2pStatus,
  planHash,
  planNumberPurchase,
  planNumberSearch,
  planSubaccount,
  planTestCall,
  planTestCallChecks,
} from './twilio-plans.mjs';
import { OnboardingBlockedError, executePlan, liveModeEnabled, masterCredentials, publicResults } from './twilio-executor.mjs';

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const ALERT_ERROR_CODES = Object.freeze(['31920', '15003']);

function stepState(onboarding, stepId) {
  onboarding.state.steps[stepId] ||= { status: 'pending' };
  return onboarding.state.steps[stepId];
}

async function subaccountCredentials(env, shopId, getSecret) {
  const [accountSid, authToken] = await Promise.all([
    getSecret(env, shopId, TWILIO_SECRET_NAMES.accountSid),
    getSecret(env, shopId, TWILIO_SECRET_NAMES.authToken),
  ]);
  return accountSid && authToken ? { accountSid, authToken } : null;
}

export async function onboardingFacts(env, onboarding, { getSecret }) {
  const [questionnaire, partstech, quickbooks] = await Promise.all([
    loadQuestionnaire(env, onboarding.shopId),
    getSecret(env, onboarding.shopId, PARTSTECH_SECRET_NAME).catch(() => ''),
    getSecret(env, onboarding.shopId, QUICKBOOKS_SECRET_NAME).catch(() => ''),
  ]);
  const questionnaireValidation = validateQuestionnaire(mergeIntakeIntoAnswers(questionnaire.answers, onboarding.intake));
  const integrationsStep = onboarding.state.steps.integrations?.status;
  return {
    intake: validateIntake(onboarding.intake).valid,
    questionnaire: questionnaireValidation.valid,
    integrations: integrationsStep === 'skipped' || Boolean(partstech && quickbooks),
    partstechConnected: Boolean(partstech),
    quickbooksConnected: Boolean(quickbooks),
    questionnaireValidation: { valid: questionnaireValidation.valid, missing: questionnaireValidation.missing, errors: questionnaireValidation.errors, progress: questionnaireValidation.progress },
    lastTestCall: onboarding.state.testCalls?.[0] || null,
  };
}

export async function onboardingSummary(env, onboarding, { getSecret, now = new Date() }) {
  const facts = await onboardingFacts(env, onboarding, { getSecret });
  const checklist = buildChecklist(onboarding, { now, facts });
  return {
    shopId: onboarding.shopId,
    status: overallStatus(checklist),
    startedAt: onboarding.startedAt,
    intake: { ...onboarding.intake, ein: onboarding.intake.ein ? `XX-XXX${String(onboarding.intake.ein).replace(/\D/g, '').slice(-4)}` : '' },
    checklist,
    facts,
    twilio: onboarding.state.twilio,
    a2p: onboarding.state.a2p,
    testCalls: onboarding.state.testCalls,
    alerts: onboarding.state.alerts,
    phoneLive: onboarding.state.phoneLive,
    smsLive: onboarding.state.smsLive,
    liveModeEnabled: liveModeEnabled(env),
    masterCredentialsConfigured: Boolean(masterCredentials(env)),
  };
}

/** Build the plan for a step; throws OnboardingBlockedError when preconditions fail. */
export async function buildStepPlan(env, onboarding, stepId, { getSecret }) {
  const step = STEP_BY_ID[stepId];
  if (!step) throw new OnboardingBlockedError('Unknown onboarding step', 'unknown_step');
  const intakeCheck = validateIntake(onboarding.intake);
  if (!intakeCheck.valid && !['intake', 'checkin_30', 'integrations'].includes(stepId)) {
    throw new OnboardingBlockedError(`Finish the intake first: ${intakeCheck.errors.map(error => error.message).join(' ')}`, 'intake_incomplete');
  }
  const intake = intakeCheck.intake;
  const twilio = onboarding.state.twilio || {};
  const a2p = onboarding.state.a2p || {};
  const costs = ESTIMATED_COSTS[stepId] || null;

  switch (stepId) {
    case 'roles':
      return { kind: 'internal', step, preview: planShopRoles(intake), hashInput: planShopRoles(intake) };
    case 'twilio_subaccount':
      if (twilio.subaccountSid) throw new OnboardingBlockedError('The subaccount already exists', 'already_done');
      return { kind: 'twilio', step, requests: planSubaccount(intake), costs };
    case 'twilio_number': {
      if (!twilio.subaccountSid) throw new OnboardingBlockedError('Create the Twilio subaccount first', 'needs_subaccount');
      if (twilio.numberSid) throw new OnboardingBlockedError('A number is already provisioned for this shop', 'already_done');
      if (!isE164Phone(twilio.selectedNumber)) throw new OnboardingBlockedError('Search for numbers and select one first', 'needs_number_selection');
      return { kind: 'twilio', step, requests: planNumberPurchase(env, intake, twilio.subaccountSid, twilio.selectedNumber), costs };
    }
    case 'a2p_brand':
      if (!twilio.numberSid) throw new OnboardingBlockedError('Buy and route the number first', 'needs_number');
      if (a2p.brandSid) throw new OnboardingBlockedError('The brand is already submitted', 'already_done');
      return {
        kind: 'twilio',
        step,
        requests: planA2pBrand(env, intake, { subaccountSid: twilio.subaccountSid, numberSid: twilio.numberSid, primaryCustomerProfileSid: String(env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID || '') }),
        costs,
        warnings: env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID ? [] : ['TWILIO_PRIMARY_CUSTOMER_PROFILE_SID is not set; live submission will fail until it is.'],
      };
    case 'a2p_campaign':
      if (!a2p.brandSid || !a2p.messagingServiceSid) throw new OnboardingBlockedError('Submit the brand first', 'needs_brand');
      if (a2p.campaignSid) throw new OnboardingBlockedError('The campaign is already submitted', 'already_done');
      if (String(a2p.brandStatus || '').toUpperCase() !== 'APPROVED') throw new OnboardingBlockedError(`The brand must be APPROVED before the campaign (currently ${a2p.brandStatus || 'unknown'}). Poll A2P status.`, 'brand_not_approved');
      return { kind: 'twilio', step, requests: planA2pCampaign(intake, { messagingServiceSid: a2p.messagingServiceSid, brandSid: a2p.brandSid }), costs };
    case 'grok_setup': {
      const answers = (await loadQuestionnaire(env, onboarding.shopId)).answers;
      const preview = { voice: mergeIntakeIntoAnswers(answers, intake).voice || intake.voice, note: 'Regenerates the Front Desk and Tech Assistant personas from intake + questionnaire. Internal to ShopCrank; does not call xAI.' };
      return { kind: 'internal', step, preview, hashInput: preview };
    }
    case 'test_calls':
      if (!twilio.phoneNumber) throw new OnboardingBlockedError('Buy and route the number first', 'needs_number');
      return { kind: 'twilio', step, requests: planTestCall(env, { toNumber: twilio.phoneNumber }), costs, warnings: env.ONBOARDING_TEST_CALLER_NUMBER ? [] : ['ONBOARDING_TEST_CALLER_NUMBER is not set.'] };
    case 'calls_go_live': {
      const facts = await onboardingFacts(env, onboarding, { getSecret });
      const blockers = [];
      if (!twilio.numberSid) blockers.push('The number is not provisioned.');
      if (!facts.questionnaire) blockers.push(`The Front Desk questionnaire is incomplete (${facts.questionnaireValidation.missing.length} missing, ${facts.questionnaireValidation.errors.length} invalid).`);
      if (!onboarding.state.testCalls?.some(call => call.passed === true)) blockers.push('No passing test call yet.');
      if (onboarding.state.steps.grok_setup?.status !== 'done') blockers.push('Generate the Grok personas first.');
      if (blockers.length) throw new OnboardingBlockedError(`Phone go-live is blocked: ${blockers.join(' ')}`, 'go_live_blocked');
      const preview = { phoneNumber: twilio.phoneNumber, change: 'Calls to the shop number reach the Grok Front Desk instead of forwarding to the current shop phone.' };
      return { kind: 'internal_gated', step, preview, hashInput: preview };
    }
    case 'sms_go_live': {
      const status = String(a2p.campaignStatus || '').toUpperCase();
      if (status !== 'VERIFIED') throw new OnboardingBlockedError(`SMS go-live needs a VERIFIED campaign (currently ${a2p.campaignStatus || 'not submitted'}).`, 'campaign_not_verified');
      const preview = { messagingServiceSid: a2p.messagingServiceSid, change: 'ShopCrank texts for this shop send through the verified messaging service.' };
      return { kind: 'internal_gated', step, preview, hashInput: preview };
    }
    default:
      throw new OnboardingBlockedError('This step completes on its own or is checked off manually', 'not_plannable');
  }
}

async function hashFor(stepId, plan) {
  return plan.requests ? planHash(stepId, plan.requests) : planHash(stepId, [{ key: 'internal', method: 'APPLY', base: 'internal', path: stepId, form: plan.hashInput }]);
}

export async function previewStep(env, onboarding, stepId, { getSecret, actor }) {
  const plan = await buildStepPlan(env, onboarding, stepId, { getSecret });
  const hash = await hashFor(stepId, plan);
  const state = stepState(onboarding, stepId);
  state.planHash = hash;
  state.plannedAt = new Date().toISOString();
  if (!['done'].includes(state.status)) state.status = plan.kind === 'internal' ? 'ready' : 'awaiting_approval';
  await saveOnboarding(env, onboarding);
  await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: stepId, kind: 'planned', mode: 'dry_run', detail: { planHash: hash }, actor });
  return {
    step: stepId,
    kind: plan.kind,
    planHash: hash,
    requiresApproval: plan.kind !== 'internal',
    external: Boolean(STEP_BY_ID[stepId].external),
    spends: Boolean(STEP_BY_ID[stepId].spends),
    costs: plan.costs || null,
    warnings: plan.warnings || [],
    requests: plan.requests ? describePlan(plan.requests, onboarding.intake) : undefined,
    preview: plan.preview,
    liveModeEnabled: liveModeEnabled(env),
  };
}

export async function approveStep(env, onboarding, stepId, { planHash: approvedHash, actor, getSecret, now = Date.now() }) {
  const plan = await buildStepPlan(env, onboarding, stepId, { getSecret });
  if (plan.kind === 'internal') throw new OnboardingBlockedError('This step does not need approval', 'no_approval_needed');
  const hash = await hashFor(stepId, plan);
  if (!approvedHash || approvedHash !== hash) throw new OnboardingBlockedError('The plan changed since it was previewed. Preview it again and approve the new plan.', 'plan_changed');
  const state = stepState(onboarding, stepId);
  state.approval = { planHash: hash, approvedBy: actor, approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString() };
  state.status = 'approved';
  await saveOnboarding(env, onboarding);
  await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: stepId, kind: 'approved', detail: { planHash: hash }, actor });
  return state.approval;
}

function requireApproval(state, hash, now) {
  const approval = state.approval;
  if (!approval) throw new OnboardingBlockedError('Operator approval is required before running this step live.', 'approval_required');
  if (approval.usedAt) throw new OnboardingBlockedError('That approval was already used. Preview and approve again.', 'approval_used');
  if (approval.planHash !== hash) throw new OnboardingBlockedError('The plan changed after approval. Preview and approve again.', 'plan_changed');
  if (Date.parse(approval.expiresAt) <= now) throw new OnboardingBlockedError('The approval expired. Preview and approve again.', 'approval_expired');
}

async function applyTwilioResults(env, onboarding, stepId, results, { saveSecret }) {
  const twilio = onboarding.state.twilio;
  const a2p = onboarding.state.a2p;
  if (stepId === 'twilio_subaccount') {
    const { sid, auth_token: authToken } = results.subaccount || {};
    if (!sid || !authToken) throw new OnboardingBlockedError('Twilio did not return the subaccount credentials', 'twilio_error');
    await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.accountSid, sid);
    await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.authToken, authToken);
    twilio.subaccountSid = sid;
  }
  if (stepId === 'twilio_number') {
    twilio.twimlAppSid = results.twiml_app?.sid || '';
    twilio.numberSid = results.number?.sid || '';
    twilio.phoneNumber = results.number?.phone_number || twilio.selectedNumber;
    await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.fromNumber, twilio.phoneNumber);
  }
  if (stepId === 'a2p_brand') {
    Object.assign(a2p, {
      customerProfileSid: results.customer_profile?.sid || '',
      trustProductSid: results.trust_product?.sid || '',
      brandSid: results.brand?.sid || '',
      brandStatus: results.brand?.status || 'PENDING',
      messagingServiceSid: results.messaging_service?.sid || '',
      submittedAt: new Date().toISOString(),
    });
  }
  if (stepId === 'a2p_campaign') {
    a2p.campaignSid = results.campaign?.sid || '';
    a2p.campaignStatus = results.campaign?.campaign_status || 'IN_PROGRESS';
  }
  if (stepId === 'test_calls') {
    onboarding.state.testCalls = [{ callSid: results.test_call?.sid || '', startedAt: new Date().toISOString(), status: 'placed', passed: null }, ...(onboarding.state.testCalls || [])].slice(0, 10);
  }
}

export async function executeStep(env, onboarding, stepId, { mode = 'dry_run', actor, getSecret, saveSecret, fetcher = fetch, now = Date.now() }) {
  const plan = await buildStepPlan(env, onboarding, stepId, { getSecret });
  const hash = await hashFor(stepId, plan);
  const state = stepState(onboarding, stepId);
  const live = mode === 'live';
  state.lastMode = live ? 'live' : 'dry_run';

  if (!live) {
    const dryRun = plan.requests
      ? await executePlan(env, plan.requests, { mode: 'dry_run', credentials: { master: masterCredentials(env) } })
      : { mode: 'dry_run', calledTwilio: false, preview: plan.preview };
    await saveOnboarding(env, onboarding);
    await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: stepId, kind: 'dry_run', mode: 'dry_run', detail: { planHash: hash }, actor });
    return { ...dryRun, step: stepId, planHash: hash, requiresApproval: plan.kind !== 'internal' };
  }

  if (plan.kind !== 'internal') requireApproval(state, hash, now);
  if (plan.kind !== 'internal' && !liveModeEnabled(env)) {
    throw new OnboardingBlockedError('Live onboarding is disabled. Set ONBOARDING_LIVE_MODE=1 on the Worker to allow live Twilio calls.', 'live_mode_disabled');
  }

  const claim = await claimExecution(env, {
    shopId: onboarding.shopId, stepId, hash,
    legacyPartial: Boolean(state.partialResults && !state.executionRunId),
  });
  state.executionRunId = claim.runId;
  state.partialPlanHash = hash;
  try {
    let output;
    if (plan.kind === 'twilio') {
      const credentials = { master: masterCredentials(env), subaccount: await subaccountCredentials(env, onboarding.shopId, getSecret) };
      const previous = { ...claim.results };
      if (stepId === 'twilio_subaccount' && previous.subaccount?.sid) {
        const saved = await subaccountCredentials(env, onboarding.shopId, getSecret);
        if (!saved || saved.accountSid !== previous.subaccount.sid) throw new OnboardingBlockedError('Subaccount credentials need reconciliation; no new account will be created.', 'reconciliation_required');
        previous.subaccount = { ...previous.subaccount, auth_token: saved.authToken };
      }
      const run = await executePlan(env, plan.requests, {
        mode: 'live',
        credentials,
        previous,
        fetcher,
        onBeforeRequest: key => checkpointExecution(env, claim, { pendingKey: key }),
        onResult: async (key, value, all) => {
          if (stepId === 'twilio_subaccount' && key === 'subaccount') {
            if (!value.sid || !value.auth_token) throw new OnboardingBlockedError('Subaccount credentials missing; reconcile the provider account.', 'reconciliation_required');
            await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.accountSid, value.sid);
            await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.authToken, value.auth_token);
          }
          await checkpointExecution(env, claim, { results: publicResults(all) });
          state.partialResults = publicResults(all);
          await saveOnboarding(env, onboarding);
        },
      });
      await applyTwilioResults(env, onboarding, stepId, run.results, { saveSecret });
      output = { mode: 'live', calledTwilio: true, results: publicResults(run.results) };
      delete state.partialResults;
    } else if (stepId === 'roles') {
      output = { mode: 'live', ...(await provisionShopRoles(env, validateIntake(onboarding.intake).intake, { actor })) };
    } else if (stepId === 'grok_setup') {
      const generated = await regenerateShopPersonas(env, onboarding.shopId, { actor });
      output = { mode: 'live', frontDeskReady: generated.validation.valid, voice: generated.frontDesk.voice };
    } else if (stepId === 'calls_go_live') {
      onboarding.state.phoneLive = true;
      output = { mode: 'live', phoneLive: true };
    } else if (stepId === 'sms_go_live') {
      await saveSecret(env, onboarding.shopId, TWILIO_SECRET_NAMES.messagingServiceSid, onboarding.state.a2p.messagingServiceSid);
      onboarding.state.smsLive = true;
      output = { mode: 'live', smsLive: true };
    }
    if (state.approval) state.approval.usedAt = new Date(now).toISOString();
    state.status = stepId === 'test_calls' ? 'running' : (stepId === 'a2p_brand' || stepId === 'a2p_campaign' ? 'submitted' : 'done');
    if (state.status === 'done') state.completedAt = new Date(now).toISOString();
    delete state.error;
    await saveOnboarding(env, onboarding);
    await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: stepId, kind: 'executed', mode: 'live', detail: { planHash: hash, output: { ...output, results: output.results ? Object.keys(output.results) : undefined } }, actor });
    await checkpointExecution(env, claim, { status: 'completed' });
    return { step: stepId, ...output };
  } catch (error) {
    state.status = 'failed';
    state.error = String(error?.message || error).slice(0, 500);
    state.partialResults = claim.results;
    await checkpointExecution(env, claim, {
      status: claim.pendingKey && !error?.definitiveFailure ? 'reconcile' : 'failed',
      pendingKey: error?.definitiveFailure ? null : claim.pendingKey,
    });
    await saveOnboarding(env, onboarding);
    await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: stepId, kind: 'failed', mode: 'live', detail: { error: state.error, failedKey: error?.failedKey }, actor });
    throw error;
  }
}

/** Read-only, free number search. Dry-run returns the request and sample numbers. */
export async function searchNumbers(env, onboarding, { mode = 'dry_run', getSecret, fetcher = fetch, actor }) {
  const intake = validateIntake(onboarding.intake).intake;
  const twilio = onboarding.state.twilio;
  const requests = planNumberSearch(intake, twilio.subaccountSid || '<subaccount>');
  if (mode !== 'live') {
    const candidates = ['0101', '0123', '0188'].map(suffix => `+1${intake.areaCode}555${suffix}`);
    twilio.candidates = candidates.map(phone => ({ phoneNumber: phone, locality: 'dry run', dryRun: true }));
    await saveOnboarding(env, onboarding);
    return { mode: 'dry_run', calledTwilio: false, requests: describePlan(requests), candidates: twilio.candidates };
  }
  if (!twilio.subaccountSid) throw new OnboardingBlockedError('Create the Twilio subaccount first', 'needs_subaccount');
  const run = await executePlan(env, requests, { mode: 'live', credentials: { subaccount: await subaccountCredentials(env, onboarding.shopId, getSecret) }, fetcher });
  twilio.candidates = (run.results.search?.available_phone_numbers || []).slice(0, 10).map(item => ({ phoneNumber: item.phone_number, locality: item.locality || '', region: item.region || '' }));
  await saveOnboarding(env, onboarding);
  await recordOnboardingEvent(env, { shopId: onboarding.shopId, step: 'twilio_number', kind: 'searched', mode: 'live', detail: { count: twilio.candidates.length }, actor });
  return { mode: 'live', candidates: twilio.candidates };
}

export async function selectNumber(env, onboarding, phoneNumber) {
  const twilio = onboarding.state.twilio;
  if (!(twilio.candidates || []).some(item => item.phoneNumber === phoneNumber)) throw new OnboardingBlockedError('Pick one of the numbers from the latest search', 'not_a_candidate');
  twilio.selectedNumber = phoneNumber;
  const state = stepState(onboarding, 'twilio_number');
  delete state.approval;
  state.status = 'pending';
  await saveOnboarding(env, onboarding);
  return { selectedNumber: phoneNumber };
}

const BRAND_FINAL = new Set(['APPROVED', 'FAILED', 'SUSPENDED']);
const CAMPAIGN_FINAL = new Set(['VERIFIED', 'FAILED']);

/** Poll customer profile, trust product, brand, and campaign status; alert on changes. */
export async function pollA2pStatus(env, onboarding, { mode = 'dry_run', getSecret, fetcher = fetch }) {
  const a2p = onboarding.state.a2p;
  const requests = planA2pStatus(a2p);
  if (!requests.length) return { mode, changed: [], message: 'Nothing submitted yet.' };
  if (mode !== 'live') return { mode: 'dry_run', calledTwilio: false, requests: describePlan(requests) };
  const run = await executePlan(env, requests, { mode: 'live', credentials: { subaccount: await subaccountCredentials(env, onboarding.shopId, getSecret) }, fetcher });
  const next = {
    customerProfileStatus: run.results.customer_profile?.status,
    trustProductStatus: run.results.trust_product?.status,
    brandStatus: run.results.brand?.status,
    brandFailureReason: run.results.brand?.failure_reason,
    campaignStatus: run.results.campaign?.campaign_status,
  };
  const changed = [];
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === a2p[key]) continue;
    changed.push({ key, from: a2p[key] || null, to: value });
    a2p[key] = value;
  }
  a2p.lastPolledAt = new Date().toISOString();
  for (const change of changed) {
    const value = String(change.to || '').toUpperCase();
    const failed = /FAIL|REJECT|SUSPEND/.test(value);
    const final = BRAND_FINAL.has(value) || CAMPAIGN_FINAL.has(value) || /APPROVED/.test(value);
    if (failed || final) {
      await raiseOnboardingAlert(env, onboarding, {
        level: failed ? 'error' : 'success',
        kind: `a2p_${change.key}`,
        message: `A2P ${change.key.replace(/Status$/, '')} is now ${change.to}${next.brandFailureReason && failed ? `: ${next.brandFailureReason}` : ''}.`,
      });
    }
  }
  if (String(a2p.campaignStatus || '').toUpperCase() === 'VERIFIED') stepState(onboarding, 'a2p_campaign').status = 'done';
  if (String(a2p.brandStatus || '').toUpperCase() === 'APPROVED') stepState(onboarding, 'a2p_brand').status = 'done';
  await saveOnboarding(env, onboarding);
  return { mode: 'live', changed, a2p };
}

/** Pass when the call connected and no 31920 or 15003 alerts fired during it. */
export function evaluateTestCall({ outboundCall = {}, inboundCalls = [], alerts = [], evidence = [], startedAt, callSid = '', fromNumber = '', toNumber = '' }) {
  const startedMs = Date.parse(startedAt || 0) - 60_000;
  const relevantAlerts = alerts.filter(alert => {
    const code = String(alert.error_code ?? alert.errorCode ?? '');
    if (!ALERT_ERROR_CODES.includes(code)) return false;
    const created = Date.parse(alert.date_created || alert.dateCreated || 0);
    return !Number.isFinite(created) || created >= startedMs;
  });
  const outboundStatus = String(outboundCall.status || '');
  const duration = Number(outboundCall.duration || 0);
  const inbound = inboundCalls.find(call => {
    const start = Date.parse(call.start_time || call.date_created || '');
    const expectedStart = Date.parse(startedAt);
    return ['completed', 'in-progress'].includes(String(call.status || ''))
      && fromNumber && toNumber && call.from === fromNumber && call.to === toNumber
      && Number.isFinite(start) && start >= expectedStart - 60_000 && start <= expectedStart + 120_000
      && evidence.some(item => item.call_sid === call.sid && item.stream_sid && item.media_started_at && item.xai_started_at
        && Date.parse(item.media_started_at) >= expectedStart - 60_000
        && Date.parse(item.xai_started_at) >= Date.parse(item.media_started_at));
  });
  const checks = [
    { id: 'connected', passed: outboundStatus === 'completed' && duration >= 5, detail: `Outbound call ${outboundStatus || 'unknown'}, ${duration}s.` },
    { id: 'inbound_leg', passed: Boolean(inbound), detail: inbound ? `Inbound leg ${inbound.sid || ''} ${inbound.status}.` : 'No inbound leg on the shop subaccount.' },
    { id: 'media_and_xai', passed: Boolean(inbound), detail: 'The matching inbound call must have Media Stream start and xAI session.updated evidence.' },
    { id: 'no_31920', passed: !relevantAlerts.some(alert => String(alert.error_code ?? alert.errorCode) === '31920'), detail: 'Media Stream handshake (31920).' },
    { id: 'no_15003', passed: !relevantAlerts.some(alert => String(alert.error_code ?? alert.errorCode) === '15003'), detail: 'Call progress / status callback errors (15003).' },
  ];
  return { callSid, passed: checks.every(check => check.passed), checks, alerts: relevantAlerts.map(alert => ({ code: String(alert.error_code ?? alert.errorCode), text: String(alert.alert_text || '').slice(0, 200), at: alert.date_created })) };
}

export async function checkTestCall(env, onboarding, { mode = 'dry_run', getSecret, fetcher = fetch }) {
  const latest = onboarding.state.testCalls?.[0];
  if (!latest?.callSid) throw new OnboardingBlockedError('Place a test call first', 'no_test_call');
  const requests = planTestCallChecks({ masterCallSid: latest.callSid, subaccountSid: onboarding.state.twilio.subaccountSid, toNumber: onboarding.state.twilio.phoneNumber, startedAt: latest.startedAt });
  if (mode !== 'live') return { mode: 'dry_run', calledTwilio: false, requests: describePlan(requests) };
  const run = await executePlan(env, requests, {
    mode: 'live',
    credentials: { master: masterCredentials(env), subaccount: await subaccountCredentials(env, onboarding.shopId, getSecret) },
    fetcher,
  });
  const report = evaluateTestCall({
    outboundCall: run.results.outbound_call,
    inboundCalls: run.results.inbound_calls?.calls || [],
    alerts: run.results.alerts?.alerts || [],
    startedAt: latest.startedAt,
    callSid: latest.callSid,
    fromNumber: String(env.ONBOARDING_TEST_CALLER_NUMBER || '').trim(),
    toNumber: onboarding.state.twilio.phoneNumber,
    evidence: (await env.DB.prepare('SELECT * FROM onboarding_voice_evidence WHERE shop_id = ? AND media_started_at >= ?')
      .bind(onboarding.shopId, new Date(Date.parse(latest.startedAt) - 60_000).toISOString()).all()).results || [],
  });
  Object.assign(latest, { status: report.passed ? 'passed' : 'failed', passed: report.passed, checks: report.checks, alerts: report.alerts, checkedAt: new Date().toISOString() });
  const state = stepState(onboarding, 'test_calls');
  state.status = report.passed ? 'done' : 'failed';
  if (report.passed) state.completedAt = new Date().toISOString();
  if (!report.passed) await raiseOnboardingAlert(env, onboarding, { level: 'error', kind: 'test_call_failed', message: `Test call ${latest.callSid} failed: ${report.checks.filter(check => !check.passed).map(check => check.detail).join(' ')}` });
  await saveOnboarding(env, onboarding);
  return { mode: 'live', report };
}
