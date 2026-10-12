import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  ANTHROPIC_TOOLS,
  buildAssistantSystemPrompt,
  MECHPRO_SYSTEM_PROMPT,
  calculateTextCost,
  executeGroundingTool,
  loadShopPricing,
  prepareEstimateWorkOrderDraft,
  readAudioWithinLimit,
  runAnthropicTurn,
  selectAnthropicModel,
  selectTextProvider,
  shouldEscalateToOpus,
  transcribeDeepgramAudio,
} from '../src/ai.mjs';
import { AiChatSession } from '../src/chat-session.mjs';
import { buildDeepgramSettings } from '../src/voice-session.mjs';

function secret() {
  return crypto.randomUUID();
}

test('model routing defaults to Sonnet and explicitly supports Opus escalation', () => {
  const env = { ANTHROPIC_SONNET_MODEL: 'sonnet-test', ANTHROPIC_OPUS_MODEL: 'opus-test' };
  assert.deepEqual(selectAnthropicModel(env), {
    family: 'sonnet',
    model: 'sonnet-test',
    routingReason: 'default_sonnet',
  });
  assert.equal(selectAnthropicModel(env, { requestedModel: 'opus' }).model, 'opus-test');
  const hardDiagnostic = 'This intermittent CAN bus no-communication comeback is still failing after replacement. Review the scope waveform.';
  assert.equal(shouldEscalateToOpus(hardDiagnostic), true);
  assert.equal(selectAnthropicModel(env, { autoEscalate: true, message: hardDiagnostic }).family, 'opus');
  assert.throws(() => selectAnthropicModel(env, { requestedModel: 'small' }), /sonnet.*opus/);
});

test('system prompt requires detailed, evidence-grounded answers', () => {
  assert.match(MECHPRO_SYSTEM_PROMPT, /detailed/i);
  assert.match(MECHPRO_SYSTEM_PROMPT, /never guess/i);
  assert.match(MECHPRO_SYSTEM_PROMPT, /ask for the missing VIN/i);
  assert.match(MECHPRO_SYSTEM_PROMPT, /read-only/i);
  assert.match(buildAssistantSystemPrompt(), /prepare_estimate_work_order/);
  assert.match(buildAssistantSystemPrompt(), /\$140\.00 per labor hour/);
  assert.match(buildAssistantSystemPrompt(), /\$200 flat fee/);
  assert.match(buildAssistantSystemPrompt(), /never calculate it as a percentage of labor/);
});

test('assistant pricing prompt uses rates from tenant-scoped shop settings', async () => {
  const statements = [];
  const env = {
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: secret(),
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            statements.push({ sql, args });
            return {
              async all() {
                return {
                  results: [
                    { entity_id: 'profile', data_json: JSON.stringify({ laborRate: 175 }) },
                    { entity_id: 'tax', data_json: JSON.stringify({ rate: 6.5 }) },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const pricing = await loadShopPricing(env, 'shop-a');
  assert.deepEqual(pricing, { laborRate: 175, taxRate: 6.5 });
  assert.deepEqual(statements[0].args, ['shop-a', 'shopsettings', 'profile', 'tax']);
  assert.match(statements[0].sql, /shop_id = \?/);

  let payload;
  await runAnthropicTurn(env, {
    shopId: 'shop-a',
    message: 'Prepare an estimate.',
    fetcher: async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json({
        content: [{ type: 'text', text: 'I can prepare a reviewable estimate.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  assert.match(payload.system, /\$175\.00 per labor hour, 6\.50% tax/);
});

test('estimate and work-order tool creates a bounded review draft without persistence', () => {
  const result = prepareEstimateWorkOrderDraft({
    customer: { name: 'Caller' },
    vehicle: { description: '2020 Example' },
    complaint: 'Noise',
    requestedServices: ['Inspect noise'],
    parts: [{ description: 'Unpriced cover', quantity: 1, unitPrice: 0, priceStatus: 'pending' }],
    labor: [{ description: 'Inspection', hours: 1, source: 'Caller-provided time' }],
    afterMidnightFee: true,
  }, { laborRate: 175, taxRate: 6.5 });
  assert.equal(result.kind, 'estimate_work_order_draft');
  assert.equal(result.requiresUserReview, true);
  assert.equal(result.saved, false);
  assert.equal(result.draft.parts[0].priceStatus, 'pending');
  assert.equal(result.draft.afterMidnightFee, true);
  assert.deepEqual(result.pricing, { laborRate: 175, taxRate: 6.5 });
  const tool = ANTHROPIC_TOOLS.find(item => item.name === 'prepare_estimate_work_order');
  assert.ok(tool.input_schema.properties.parts.items.required.includes('priceStatus'));
  assert.equal(tool.input_schema.properties.afterMidnightFee.type, 'boolean');
  const omittedStatus = prepareEstimateWorkOrderDraft({
    customer: { name: 'Caller' },
    vehicle: { description: '2020 Example' },
    complaint: 'Noise',
    requestedServices: [],
    parts: [{ description: 'Unknown part', quantity: 1, unitPrice: 0 }],
    labor: [],
  });
  assert.equal(omittedStatus.draft.parts[0].priceStatus, 'pending');
});

test('grounding lookup is tenant-scoped and read-only', async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            statements.push({ sql, args });
            return {
              async all() {
                return {
                  results: [{
                    entity_id: 'EST-100',
                    data_json: JSON.stringify({ id: 'EST-100', customer: 'Customer A', amount: 125 }),
                    updated_at: '2026-10-02T00:00:00.000Z',
                  }],
                };
              },
            };
          },
        };
      },
    },
  };
  const result = await executeGroundingTool(env, 'shop-a', 'lookup_estimate', { id: 'EST-100' });
  assert.equal(result.readOnly, true);
  assert.equal(result.records[0].amount, 125);
  assert.deepEqual(statements[0].args, ['shop-a', 'estimates', 'EST-100']);
  assert.match(statements[0].sql, /shop_id = \?/);
});

test('Anthropic turn executes read-only tools and accumulates token usage', async () => {
  const requests = [];
  const responses = [
    {
      content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup_invoice', input: { id: 'INV-9' } }],
      usage: { input_tokens: 50, output_tokens: 10 },
    },
    {
      content: [{ type: 'text', text: 'Invoice INV-9 is open. The record does not include payment confirmation.' }],
      usage: { input_tokens: 80, output_tokens: 20 },
    },
  ];
  const env = {
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: secret(),
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [{
                    entity_id: 'INV-9',
                    data_json: JSON.stringify({ id: 'INV-9', status: 'open' }),
                    updated_at: '2026-10-02T00:00:00.000Z',
                  }],
                };
              },
            };
          },
        };
      },
    },
  };
  const result = await runAnthropicTurn(env, {
    shopId: 'shop-a',
    message: 'Is INV-9 paid?',
    fetcher: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return Response.json(responses.shift());
    },
  });
  assert.equal(result.inputTokens, 130);
  assert.equal(result.outputTokens, 30);
  assert.match(result.text, /does not include payment confirmation/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[1].body.messages.at(-1).content[0].type, 'tool_result');
  assert.match(requests[1].body.messages.at(-1).content[0].content, /"readOnly":true/);
});

test('Anthropic turn returns a reviewable estimate action from the preparation tool', async () => {
  const responses = [
    {
      content: [{
        type: 'tool_use',
        id: 'tool-draft',
        name: 'prepare_estimate_work_order',
        input: {
          customer: { name: 'Caller' },
          vehicle: { description: '2020 Example' },
          complaint: 'Noise',
          requestedServices: ['Inspect noise'],
          parts: [],
          labor: [{ description: 'Inspection', hours: 1, source: 'Customer-provided estimate' }],
        },
      }],
      usage: { input_tokens: 20, output_tokens: 10 },
    },
    {
      content: [{ type: 'text', text: 'I prepared a draft for review.' }],
      usage: { input_tokens: 30, output_tokens: 10 },
    },
  ];
  const result = await runAnthropicTurn({
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: secret(),
  }, {
    shopId: 'shop-a',
    message: 'Create the estimate and work order.',
    fetcher: async () => Response.json(responses.shift()),
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, 'estimate_work_order_draft');
  assert.equal(result.actions[0].saved, false);
  assert.deepEqual(result.actions[0].pricing, { laborRate: 140, taxRate: 8.25 });
});

test('Deepgram transcription fails honestly without a configured key', async () => {
  await assert.rejects(
    () => transcribeDeepgramAudio({ AI_ENABLED: '1' }, new Uint8Array([1]).buffer),
    /Voice transcription is not configured/,
  );
});

test('Deepgram transcription returns provider text without exposing the key', async () => {
  const apiKey = secret();
  const result = await transcribeDeepgramAudio({
    AI_ENABLED: '1',
    DEEPGRAM_API_KEY: apiKey,
    DEEPGRAM_LISTEN_MODEL: 'nova-test',
  }, new Uint8Array([1, 2, 3]).buffer, {
    contentType: 'audio/webm',
    fetcher: async (url, init) => {
      assert.match(url, /model=nova-test/);
      assert.equal(init.headers.Authorization, `Token ${apiKey}`);
      assert.equal(init.headers['Content-Type'], 'audio/webm');
      return Response.json({
        results: { channels: [{ alternatives: [{ transcript: 'Create an estimate.' }] }] },
        metadata: { duration: 12.5 },
      });
    },
  });
  assert.equal(result.transcript, 'Create an estimate.');
  assert.equal(result.voiceSeconds, 12.5);
});

test('audio reader accepts bounded streams and cancels oversized uploads', async () => {
  const bytes = await readAudioWithinLimit(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  }), 3);
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);

  let chunk = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunk === 2) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunk++ === 0 ? 6 : 5));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() => readAudioWithinLimit(stream, 10), error => error.status === 413);
  assert.equal(cancelled, true);
});

test('phone turns do not receive estimate preparation tools they cannot return', async () => {
  let payload;
  const result = await runAnthropicTurn({
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: secret(),
  }, {
    shopId: 'shop-a',
    message: 'Prepare an estimate.',
    allowEstimatePreparation: false,
    fetcher: async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json({
        content: [{ type: 'text', text: 'I cannot create a draft in this phone interaction.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  assert.equal(payload.tools.some(tool => tool.name === 'prepare_estimate_work_order'), false);
  assert.match(payload.system, /cannot return structured drafts/);
  assert.deepEqual(result.actions, []);
});

test('cost calculation leaves unknown rates null and applies configured markup', () => {
  assert.deepEqual(calculateTextCost({}, 'sonnet', 1000, 500), {
    providerCostUsd: null,
    billedUsd: null,
  });
  assert.deepEqual(calculateTextCost({
    ANTHROPIC_SONNET_INPUT_USD_PER_MTOK: '2',
    ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK: '10',
    AI_BILLING_MARKUP_MULTIPLIER: '1.5',
  }, 'sonnet', 1_000_000, 500_000), {
    providerCostUsd: 7,
    billedUsd: 10.5,
  });
});

test('Deepgram settings use BYO Anthropic and do not expose the Deepgram credential', () => {
  const anthropicSecret = secret();
  const deepgramSecret = secret();
  const settings = buildDeepgramSettings({
    ANTHROPIC_API_KEY: anthropicSecret,
    DEEPGRAM_API_KEY: deepgramSecret,
  }, [{ type: 'orders', id: 'RO-1', status: 'open' }], { laborRate: 180, taxRate: 7 });
  assert.equal(settings.agent.think.provider.type, 'anthropic');
  assert.equal(settings.agent.think.endpoint.headers['x-api-key'], anthropicSecret);
  assert.match(settings.agent.think.prompt, /RO-1/);
  assert.match(settings.agent.think.prompt, /\$180\.00 per labor hour, 7\.00% tax/);
  assert.match(settings.agent.think.prompt, /cannot return structured drafts/);
  assert.doesNotMatch(JSON.stringify(settings), new RegExp(deepgramSecret));
});

function assistantDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async first() {
              if (/FROM users WHERE email/.test(sql)) {
                return { shop_id: 'shop-a', role: 'admin', name: 'Shop Admin', enabled: 1 };
              }
              if (/SELECT suspended FROM accounts/.test(sql)) return { suspended: 0 };
              if (/SELECT request_count FROM ai_rate_limits/.test(sql)) return { request_count: 1 };
              return null;
            },
            async run() {
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

function chatNamespace(env) {
  const sessions = new Map();
  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!sessions.has(id)) {
        const values = new Map();
        const state = {
          storage: {
            async get(key) { return values.get(key); },
            async put(key, value) { values.set(key, value); },
          },
        };
        sessions.set(id, new AiChatSession(state, env));
      }
      return sessions.get(id);
    },
  };
}

function assistantRequest() {
  return new Request('https://app.example.test/api/ai/assistant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MechPro-Dev-Email': 'admin@example.test',
    },
    body: JSON.stringify({ message: 'Explain this open estimate.', model: 'sonnet' }),
  });
}

test('authenticated assistant route calls Anthropic and records per-shop usage', async (t) => {
  const DB = assistantDb();
  const apiKey = secret();
  const provider = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], apiKey);
    return Response.json({
      content: [{ type: 'text', text: 'I need the estimate number before I can verify its details.' }],
      usage: { input_tokens: 12, output_tokens: 14 },
    });
  });
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: apiKey,
  };
  env.AI_CHAT_SESSIONS = chatNamespace(env);
  const response = await worker.fetch(assistantRequest(), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.modelFamily, 'sonnet');
  assert.match(payload.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(payload.usage.inputTokens, 12);
  assert.equal(provider.mock.callCount(), 1);
  const usageInsert = DB.calls.find(call => /INSERT INTO ai_usage_events/.test(call.sql));
  assert.ok(usageInsert);
  assert.equal(usageInsert.args[1], 'shop-a');
  assert.equal(usageInsert.args[3], 'text');
  assert.equal(usageInsert.args[6], 12);
});

test('assistant feature flag fails closed before calling a provider', async (t) => {
  const provider = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('disabled AI must not call a provider');
  });
  const response = await worker.fetch(assistantRequest(), {
    DB: assistantDb(),
    DEV_AUTH_BYPASS: '1',
    AI_ENABLED: '0',
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /not enabled/);
  assert.equal(provider.mock.callCount(), 0);
});

test('successful audio transcription records shop-scoped Deepgram usage', async (t) => {
  const DB = assistantDb();
  const apiKey = secret();
  const provider = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /^https:\/\/api\.deepgram\.com\/v1\/listen/);
    assert.equal(init.headers.Authorization, `Token ${apiKey}`);
    return Response.json({
      results: { channels: [{ alternatives: [{ transcript: 'Create an estimate.' }] }] },
      metadata: { duration: 30 },
    });
  });
  const request = new Request('https://app.example.test/api/ai/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/webm',
      'X-MechPro-Dev-Email': 'admin@example.test',
    },
    body: new Uint8Array([1, 2, 3]),
  });
  const response = await worker.fetch(request, {
    DB,
    DEV_AUTH_BYPASS: '1',
    AI_ENABLED: '1',
    DEEPGRAM_API_KEY: apiKey,
    DEEPGRAM_VOICE_USD_PER_MINUTE: '0.06',
    AI_BILLING_MARKUP_MULTIPLIER: '2',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).transcript, 'Create an estimate.');
  assert.equal(provider.mock.callCount(), 1);
  const usageInsert = DB.calls.find(call => /INSERT INTO ai_usage_events/.test(call.sql));
  assert.ok(usageInsert);
  assert.deepEqual(usageInsert.args.slice(1, 6), ['shop-a', 'local-development', 'voice', 'deepgram', 'nova-3']);
  assert.equal(usageInsert.args[8], 30);
  assert.equal(usageInsert.args[9], 0.03);
  assert.equal(usageInsert.args[10], 0.06);
});

test('assistant route falls back to the Workers AI binding when no Anthropic key is set', async (t) => {
  const DB = assistantDb();
  const provider = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Workers AI fallback must not call an external provider');
  });
  const runs = [];
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    AI_ENABLED: '1',
    AI: {
      async run(model, input) {
        runs.push({ model, input });
        return { response: 'Check the wastegate actuator first.', usage: { prompt_tokens: 40, completion_tokens: 8 } };
      },
    },
  };
  env.AI_CHAT_SESSIONS = chatNamespace(env);
  const response = await worker.fetch(assistantRequest(), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.message, 'Check the wastegate actuator first.');
  assert.equal(payload.modelFamily, 'workers-ai');
  assert.equal(payload.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.deepEqual(payload.actions, []);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].input.messages[0].role, 'system');
  assert.match(runs[0].input.messages[0].content, /cannot call tools/);
  assert.equal(runs[0].input.messages.at(-1).content, 'Explain this open estimate.');
  const usageInsert = DB.calls.find(call => /INSERT INTO ai_usage_events/.test(call.sql));
  assert.ok(usageInsert);
  assert.deepEqual(usageInsert.args.slice(1, 5), ['shop-a', 'local-development', 'text', 'workers-ai']);
  assert.equal(usageInsert.args[6], 40);
  assert.equal(usageInsert.args[9], null);
});

test('Anthropic stays primary when its key and the Workers AI binding are both present', async () => {
  const result = await runAnthropicTurn({
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: secret(),
    AI: { async run() { assert.fail('Workers AI must not be used when Anthropic is configured'); } },
  }, {
    message: 'Hello',
    fetcher: async () => Response.json({ content: [{ type: 'text', text: 'Hi.' }], usage: {} }),
  });
  assert.equal(result.provider, 'anthropic');
  assert.equal(selectTextProvider({ AI: { run() {} } }), 'workers-ai');
  assert.equal(selectTextProvider({}), null);
});

test('chat session returns provider errors with their HTTP status instead of a generic 500', async () => {
  const response = await worker.fetch(assistantRequest(), (() => {
    const env = {
      DB: assistantDb(),
      DEV_AUTH_BYPASS: '1',
      AI_ENABLED: '1',
      AI: { async run() { throw new Error('upstream down'); } },
    };
    env.AI_CHAT_SESSIONS = chatNamespace(env);
    return env;
  })());
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /provider is unavailable/);
});

test('Workers AI usage is never priced with Anthropic rates', () => {
  assert.deepEqual(
    calculateTextCost({ ANTHROPIC_SONNET_INPUT_USD_PER_MTOK: '3', ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK: '15' }, 'workers-ai', 1000, 1000),
    { providerCostUsd: null, billedUsd: null },
  );
});
