import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { createOnboarding, getOnboarding, saveOnboarding, phoneGoLiveGate } from '../src/onboarding/store.mjs';
import { approveStep, previewStep, executeStep, evaluateTestCall } from '../src/onboarding/service.mjs';
import { claimExecution, checkpointExecution, recordVoiceEvidence } from '../src/onboarding/executions.mjs';
import { executePlan } from '../src/onboarding/twilio-executor.mjs';
import { planA2pCampaign } from '../src/onboarding/twilio-plans.mjs';
import { provisionShopRoles } from '../src/onboarding/roles.mjs';
import { sendSms, createTwilioSmsProvider, TWILIO_SECRET_NAMES } from '../src/integrations/sms.mjs';
import { encryptSecret, decryptSecret } from '../src/security.mjs';
import { QUESTIONNAIRE_FIELDS, DAY_KEYS, validateQuestionnaire } from '../../src/modules/front-desk-questionnaire.js';
import { putShopSetting } from '../src/shop-settings-store.mjs';

const intake = {
  shopId: 'shop-1', legalName: 'Example Auto LLC', dbaName: 'Example Auto', ein: '12-3456789',
  businessType: 'Limited Liability Corporation', address: { street: '1 Main', city: 'Lubbock', state: 'TX', postalCode: '79401' },
  website: 'https://example.com', contact: { firstName: 'Owner', lastName: 'Example', email: 'owner@example.com', mobile: '+18065550123', jobPosition: 'CEO' },
  hours: 'Mon-Fri 8-5', services: ['Repairs'], laborRate: 150, currentPhone: '+18065550120',
  optInWording: 'Customers explicitly agree to receive repair updates by SMS.', staff: [],
};
const config = { accountSid: 'AC-test', authToken: 'test-token', fromNumber: '+18065550120' };

function fixture() {
  const env = { DB: createD1(), INTEGRATION_ENCRYPTION_KEY: 'test-only-encryption-key', ONBOARDING_LIVE_MODE: '1', TWILIO_MASTER_ACCOUNT_SID: 'AC-master', TWILIO_MASTER_AUTH_TOKEN: 'test-master-token' };
  const deps = {
    actor: 'operator@example.com',
    getSecret: async (env, shopId, name) => {
      const row = await env.DB.prepare('SELECT * FROM integration_secrets WHERE shop_id = ? AND secret_name = ?').bind(shopId, name).first();
      return row ? decryptSecret(row.ciphertext, row.iv, env.INTEGRATION_ENCRYPTION_KEY) : '';
    },
    saveSecret: async (env, shopId, name, value) => {
      const encrypted = await encryptSecret(value, env.INTEGRATION_ENCRYPTION_KEY);
      await env.DB.prepare(`INSERT INTO integration_secrets (shop_id, secret_name, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shop_id, secret_name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at`)
        .bind(shopId, name, encrypted.ciphertext, encrypted.iv, new Date().toISOString()).run();
    },
  };
  return { env, deps };
}

async function approved(env, onboarding, stepId, deps) {
  const preview = await previewStep(env, onboarding, stepId, deps);
  await approveStep(env, onboarding, stepId, { ...deps, planHash: preview.planHash });
}

test('live step claims are atomic before provider fetch; concurrent and stale calls cannot create twice', async () => {
  const { env, deps } = fixture();
  const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
  await approved(env, onboarding, 'twilio_subaccount', deps);
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    const claim = await env.DB.prepare('SELECT * FROM onboarding_executions WHERE shop_id = ?').bind('shop-1').first();
    assert.equal(claim.status, 'running');
    assert.equal(claim.pending_key, 'subaccount');
    assert.ok(claim.run_id);
    return Response.json({ sid: 'AC-sub', auth_token: 'subaccount-sensitive-token' });
  };
  const outcomes = await Promise.allSettled([structuredClone(onboarding), structuredClone(onboarding)].map(item =>
    executeStep(env, item, 'twilio_subaccount', { ...deps, mode: 'live', fetcher })));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(fetches, 1);
  await assert.rejects(executeStep(env, structuredClone(onboarding), 'twilio_subaccount', { ...deps, mode: 'live', fetcher }));
  assert.equal(fetches, 1);
});

test('subaccount token is encrypted before durable completion and securely reloaded on partial resume', async () => {
  const { env, deps } = fixture();
  const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
  await approved(env, onboarding, 'twilio_subaccount', deps);
  const basePrepare = env.DB.prepare;
  let failStateWrite = true;
  env.DB.prepare = sql => {
    const statement = basePrepare(sql);
    if (!/UPDATE shop_onboarding SET/.test(sql)) return statement;
    return { bind: (...args) => {
      const bound = statement.bind(...args);
      return { run: async () => {
        if (failStateWrite && args[2].includes('partialResults')) {
          failStateWrite = false;
          assert.equal(await deps.getSecret(env, 'shop-1', TWILIO_SECRET_NAMES.authToken), 'sensitive-sub-token');
          const checkpoint = await env.DB.prepare('SELECT * FROM onboarding_executions WHERE shop_id = ?').bind('shop-1').first();
          assert.equal(JSON.parse(checkpoint.results_json).subaccount.sid, 'AC-sub');
          throw new Error('injected state write failure');
        }
        return bound.run();
      } };
    } };
  };
  let fetches = 0;
  await assert.rejects(executeStep(env, onboarding, 'twilio_subaccount', { ...deps, mode: 'live', fetcher: async () => {
    fetches++;
    return Response.json({ sid: 'AC-sub', auth_token: 'sensitive-sub-token' });
  } }), /injected/);
  let reloaded = 0;
  const resumed = await getOnboarding(env, 'shop-1');
  await executeStep(env, resumed, 'twilio_subaccount', { ...deps, mode: 'live', getSecret: async (...args) => { reloaded++; return deps.getSecret(...args); }, fetcher: async () => assert.fail('must not create another account') });
  assert.equal(fetches, 1);
  assert.ok(reloaded >= 2);
  assert.equal(resumed.state.twilio.subaccountSid, 'AC-sub');
  const state = env.DB.sqlite.prepare('SELECT state_json FROM shop_onboarding').get().state_json;
  const checkpoint = env.DB.sqlite.prepare('SELECT * FROM onboarding_executions').get();
  assert.equal(checkpoint.status, 'completed');
  assert.doesNotMatch(JSON.stringify({ state, checkpoint }), /sensitive-sub-token|auth_token/);
  assert.doesNotMatch(JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM integration_secrets').all()), /sensitive-sub-token/);
});

test('partial checkpoints are bound to plan hash; unknown provider outcomes stay blocked for reconciliation', async () => {
  const { env } = fixture();
  const claim = await claimExecution(env, { shopId: 'shop-1', stepId: 'twilio_number', hash: 'original' });
  await checkpointExecution(env, claim, { results: { number: { sid: 'PN-existing' } }, status: 'failed' });
  await assert.rejects(claimExecution(env, { shopId: 'shop-1', stepId: 'twilio_number', hash: 'changed' }), error => error.code === 'reconciliation_required');
  const resumed = await claimExecution(env, { shopId: 'shop-1', stepId: 'twilio_number', hash: 'original' });
  assert.deepEqual(resumed.results, { number: { sid: 'PN-existing' } });
  assert.notEqual(resumed.runId, claim.runId);
  await checkpointExecution(env, resumed, { pendingKey: 'brand', status: 'reconcile' });
  await assert.rejects(claimExecution(env, { shopId: 'shop-1', stepId: 'twilio_number', hash: 'original' }));
  await assert.rejects(claimExecution(env, { shopId: 'shop-1', stepId: 'a2p_brand', hash: 'other' }), error => error.code === 'execution_claimed');
});

test('executeStep rejects a changed partially executed purchase plan and resumes only its original checkpoints', async () => {
  const { env, deps } = fixture();
  const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
  onboarding.state.twilio = { subaccountSid: 'AC-sub', selectedNumber: '+18065550121' };
  await deps.saveSecret(env, 'shop-1', TWILIO_SECRET_NAMES.accountSid, 'AC-sub');
  await deps.saveSecret(env, 'shop-1', TWILIO_SECRET_NAMES.authToken, 'test-subaccount-token');
  await approved(env, onboarding, 'twilio_number', deps);
  let requests = 0;
  await assert.rejects(executeStep(env, onboarding, 'twilio_number', { ...deps, mode: 'live', fetcher: async () => {
    requests++;
    return requests === 1
      ? Response.json({ sid: 'AP-already-created' })
      : Response.json({ message: 'Number unavailable' }, { status: 400 });
  } }), /Number unavailable/);
  assert.equal(requests, 2);
  const altered = await getOnboarding(env, 'shop-1');
  altered.state.twilio.selectedNumber = '+18065550122';
  await approved(env, altered, 'twilio_number', deps);
  await assert.rejects(executeStep(env, altered, 'twilio_number', { ...deps, mode: 'live', fetcher: async () => assert.fail('changed plan must not reach provider') }), error => error.code === 'reconciliation_required');
  altered.state.twilio.selectedNumber = '+18065550121';
  await approved(env, altered, 'twilio_number', deps);
  await executeStep(env, altered, 'twilio_number', { ...deps, mode: 'live', fetcher: async (url) => {
    requests++;
    assert.match(url, /IncomingPhoneNumbers/);
    return Response.json({ sid: 'PN-new', phone_number: '+18065550121' });
  } });
  assert.equal(requests, 3, 'completed TwiML application is not created again');
  assert.equal(altered.state.twilio.twimlAppSid, 'AP-already-created');
});

test('provider timeout or token persistence failure never permits automatic paid-resource retry', async () => {
  for (const failure of ['network', 'secret']) {
    const { env, deps } = fixture();
    const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
    await approved(env, onboarding, 'twilio_subaccount', deps);
    let fetches = 0;
    const options = { ...deps, mode: 'live', fetcher: async () => {
      fetches++;
      if (failure === 'network') throw new Error('connection lost after request');
      return Response.json({ sid: 'AC-sub', auth_token: 'not-persisted-test-token' });
    }, ...(failure === 'secret' ? { saveSecret: async () => { throw new Error('encrypted store unavailable'); } } : {}) };
    await assert.rejects(executeStep(env, onboarding, 'twilio_subaccount', options));
    const row = env.DB.sqlite.prepare('SELECT * FROM onboarding_executions').get();
    assert.equal(row.status, 'reconcile');
    assert.equal(row.pending_key, 'subaccount');
    await assert.rejects(executeStep(env, await getOnboarding(env, 'shop-1'), 'twilio_subaccount', options));
    assert.equal(fetches, 1);
  }
});

function completeAnswers() {
  const answers = {};
  for (const field of Object.values(QUESTIONNAIRE_FIELDS)) {
    if (!field.required) continue;
    answers[field.id] = field.options?.[0] || 'Shop policy';
    if (['list', 'multiselect'].includes(field.type)) answers[field.id] = [field.options?.[0] || 'General repair'];
    if (field.type === 'boolean') answers[field.id] = false;
    if (field.type === 'number') answers[field.id] = 150;
    if (field.type === 'phone') answers[field.id] = '+18065550120';
    if (field.type === 'email') answers[field.id] = 'shop@example.com';
    if (field.type === 'emailList') answers[field.id] = ['shop@example.com'];
    if (field.type === 'hours') answers[field.id] = Object.fromEntries(DAY_KEYS.map(day => [day, { closed: true }]));
    if (field.type === 'transferTargets') answers[field.id] = [{ name: 'Advisor', phone: '+18065550120', availability: 'always' }];
  }
  assert.equal(validateQuestionnaire(answers).valid, true, JSON.stringify(validateQuestionnaire(answers)));
  return answers;
}

test('approved internal calls and SMS go-live are still blocked when platform live mode is off', async () => {
  for (const stepId of ['sms_go_live', 'calls_go_live']) {
    const { env, deps } = fixture();
    env.ONBOARDING_LIVE_MODE = '';
    const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
    await putShopSetting(env, 'shop-1', 'front_desk_questionnaire', { answers: completeAnswers() });
    onboarding.state.a2p = { campaignStatus: 'VERIFIED', messagingServiceSid: 'MG-test' };
    onboarding.state.twilio = { numberSid: 'PN-test', phoneNumber: '+18065550121' };
    onboarding.state.testCalls = [{ passed: true }];
    onboarding.state.steps.grok_setup = { status: 'done' };
    await approved(env, onboarding, stepId, deps);
    await assert.rejects(executeStep(env, onboarding, stepId, { ...deps, mode: 'live', fetcher: async () => assert.fail('must not fetch') }), error => error.code === 'live_mode_disabled');
    assert.equal(onboarding.state.phoneLive, false);
    assert.equal(onboarding.state.smsLive, false);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM onboarding_executions').get().n, 0);
  }
});

test('shared SMS boundary gates onboarded shops without disabling legacy SMS or phone credentials', async () => {
  const { env } = fixture();
  const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake });
  let requests = 0;
  const options = { shopId: 'shop-1', config, fetcher: async () => { requests++; return Response.json({ sid: 'SM-test' }); } };
  await assert.rejects(sendSms(env, { to: '+18065550123', body: 'Hello' }, options), error => error.code === 'sms_onboarding_gated');
  await assert.rejects(createTwilioSmsProvider(env, options).send({ to: '+18065550123', body: 'Direct provider' }), error => error.code === 'sms_onboarding_gated');
  assert.equal(requests, 0);
  await sendSms(env, { to: '+18065550123', body: 'Legacy shop' }, { ...options, shopId: 'legacy-shop' });
  onboarding.state.smsLive = true;
  await saveOnboarding(env, onboarding);
  await sendSms(env, { to: '+18065550123', body: 'Enabled shop' }, options);
  assert.equal(requests, 2);
  assert.equal((await phoneGoLiveGate(env, 'shop-1')).gated, true, 'SMS enablement never enables voice');
  assert.equal((await phoneGoLiveGate({ ...env, ONBOARDING_TEST_CALLER_NUMBER: '+18065550123' }, 'shop-1', '+18065550123')).testCall, true);
  assert.equal((await phoneGoLiveGate(env, 'legacy-shop')).gated, false);
});

test('role provisioning processes successful staff then throws aggregate failures without reassigning cross-tenant users', async () => {
  const { env } = fixture();
  env.DB.sqlite.prepare("INSERT INTO users (id, email, shop_id, role, name, enabled, created_at, updated_at) VALUES ('other-user','taken@example.com','other-shop','admin','Other',1,'now','now')").run();
  await assert.rejects(provisionShopRoles(env, { ...intake, contact: intake.contact, staff: [
    { email: 'taken@example.com', name: 'Conflict', role: 'office' },
    { email: 'success@example.com', name: 'Tech', role: 'technician' },
  ] }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.users.map(user => user.ok), [true, false, true]);
    return true;
  });
  assert.equal(env.DB.sqlite.prepare("SELECT shop_id FROM users WHERE email = 'taken@example.com'").get().shop_id, 'other-shop');
  assert.equal(env.DB.sqlite.prepare("SELECT shop_id FROM users WHERE email = 'success@example.com'").get().shop_id, 'shop-1');
});

test('dry preview preserves every repeated Twilio form value exactly', async () => {
  const requests = planA2pCampaign({ ...intake, messageSamples: ['One', 'Two'], campaignUseCase: 'CUSTOMER_CARE' }, { messagingServiceSid: 'MG-test', brandSid: 'BN-test' });
  const preview = await executePlan({}, requests, { fetcher: async () => assert.fail('dry run must not fetch') });
  assert.deepEqual(preview.requests[0].form.MessageSamples, ['One', 'Two']);
  assert.deepEqual(preview.requests[0].form.OptInKeywords, ['START', 'YES']);
  assert.deepEqual(preview.requests[0].form.OptOutKeywords, ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
});

test('successful durable checkpoints without SIDs are not repeated on resume', async () => {
  const request = { key: 'assignment', method: 'POST', base: 'api', path: '/test', account: 'master' };
  const result = await executePlan({ ONBOARDING_LIVE_MODE: '1' }, [request], {
    mode: 'live', previous: { assignment: {} }, credentials: { master: config },
    fetcher: async () => assert.fail('completed assignment must not be repeated'),
  });
  assert.deepEqual(result.results.assignment, {});
});

test('passing test calls require matching media stream and xAI startup evidence on the same inbound call', async () => {
  const { env } = fixture();
  const input = {
    outboundCall: { status: 'completed', duration: '12' },
    inboundCalls: [{ sid: 'CA-inbound', from: '+18065550123', to: '+18065550120', status: 'completed', start_time: '2026-10-30T12:00:00Z' }],
    fromNumber: '+18065550123', toNumber: '+18065550120', startedAt: '2026-10-30T12:00:00Z', callSid: 'CA-outbound',
  };
  assert.equal(evaluateTestCall(input).passed, false, 'duration alone cannot pass');
  await recordVoiceEvidence(env, { shopId: 'shop-1', callSid: 'CA-inbound', streamSid: 'MZ-one' });
  await recordVoiceEvidence(env, { shopId: 'shop-1', callSid: 'CA-inbound', streamSid: 'MZ-wrong', xaiStarted: true });
  let evidence = env.DB.sqlite.prepare('SELECT * FROM onboarding_voice_evidence').all();
  assert.equal(evidence[0].xai_started_at, null, 'different stream cannot qualify');
  await recordVoiceEvidence(env, { shopId: 'shop-1', callSid: 'CA-inbound', streamSid: 'MZ-one', xaiStarted: true });
  env.DB.sqlite.exec("UPDATE onboarding_voice_evidence SET media_started_at = '2026-10-30T12:00:01Z', xai_started_at = '2026-10-30T12:00:02Z'");
  evidence = env.DB.sqlite.prepare('SELECT * FROM onboarding_voice_evidence').all();
  assert.equal(evaluateTestCall({ ...input, evidence }).passed, true);
  assert.equal(evaluateTestCall({ ...input, evidence: evidence.map(item => ({ ...item, call_sid: 'CA-unrelated' })) }).passed, false);
  assert.equal(evaluateTestCall({ ...input, inboundCalls: input.inboundCalls.map(item => ({ ...item, from: '+18065550999' })), evidence }).passed, false);
  assert.equal(evaluateTestCall({ ...input, alerts: [{ error_code: '31920', date_created: input.startedAt }], evidence }).passed, false);
});
