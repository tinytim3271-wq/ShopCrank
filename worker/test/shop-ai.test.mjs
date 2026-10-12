import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runAnthropicTurn, selectTextProvider, usageCostsForResult } from '../src/ai.mjs';
import { AiChatSession } from '../src/chat-session.mjs';
import { encryptSecret } from '../src/security.mjs';
import {
  AnthropicApiError,
  classifyAnthropicFailure,
  loadShopAnthropicConfig,
  maskApiKey,
  normalizeAnthropicKey,
  shopAiStatus,
  shopClaudeModel,
  validateAnthropicKey,
} from '../src/shop-ai.mjs';

const ENCRYPTION_KEY = 'test-integration-encryption-key';
const SHOP_KEY = 'sk-ant-api03-shopOwnedKeyForTests-ABCD1234';
const PLATFORM_KEY = 'sk-ant-api03-platformKeyForTests-PLAT9999';
const MASK = '\u2022\u2022\u2022\u2022';

function workersAi(runs = []) {
  return {
    async run(model, input) {
      runs.push({ model, input });
      return { response: 'Check boost pressure and the wastegate first.', usage: { prompt_tokens: 30, completion_tokens: 9 } };
    },
  };
}

function anthropicText(text = 'Claude answer.') {
  return Response.json({ content: [{ type: 'text', text }], usage: { input_tokens: 11, output_tokens: 7 } });
}

function anthropicError(status, type, message = '') {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

/** D1 mock that serves auth/session rows plus an optional shop_ai_settings row. */
function fakeDb({ shopRow = null, role = 'admin', missingAiTable = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          const aiTable = /shop_ai_settings/.test(sql);
          return {
            async first() {
              if (aiTable && missingAiTable) throw new Error('D1_ERROR: no such table: shop_ai_settings: SQLITE_ERROR');
              if (/FROM users WHERE email/.test(sql)) return { shop_id: 'shop-a', role, name: 'Shop User', enabled: 1 };
              if (/SELECT suspended FROM accounts/.test(sql)) return { suspended: 0 };
              if (/SELECT request_count FROM ai_rate_limits/.test(sql)) return { request_count: 1 };
              if (aiTable) return shopRow;
              return null;
            },
            async run() {
              if (aiTable && missingAiTable) throw new Error('D1_ERROR: no such table: shop_ai_settings: SQLITE_ERROR');
              return { success: true };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

async function encryptedRow(key = SHOP_KEY, extra = {}) {
  const encrypted = await encryptSecret(key, ENCRYPTION_KEY);
  return {
    shop_id: 'shop-a',
    key_ciphertext: encrypted.ciphertext,
    key_iv: encrypted.iv,
    key_last4: key.slice(-4),
    model: null,
    status: 'active',
    last_error: null,
    last_error_at: null,
    validated_at: '2026-10-08T00:00:00.000Z',
    updated_at: '2026-10-08T00:00:00.000Z',
    ...extra,
  };
}

function chatNamespace(env) {
  const sessions = new Map();
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!sessions.has(id)) {
        const values = new Map();
        sessions.set(id, new AiChatSession({
          storage: {
            async get(key) { return values.get(key); },
            async put(key, value) { values.set(key, value); },
          },
        }, env));
      }
      return sessions.get(id);
    },
  };
}

function apiRequest(path, method = 'GET', body = undefined) {
  return new Request(`https://app.example.test/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-MechPro-Dev-Email': 'owner@example.test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---- masking and status -------------------------------------------------

test('masking shows only the last 4 characters', () => {
  assert.equal(maskApiKey(SHOP_KEY), `${MASK}1234`);
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), MASK);
});

test('client status never contains the key or its ciphertext', async () => {
  const row = await encryptedRow();
  const status = shopAiStatus({}, row);
  const serialized = JSON.stringify(status);
  assert.equal(status.provider, 'anthropic');
  assert.equal(status.maskedKey, `${MASK}1234`);
  assert.equal(status.label, `Using Claude with your key ${MASK}1234`);
  assert.ok(!serialized.includes(SHOP_KEY));
  assert.ok(!serialized.includes(row.key_ciphertext));
  assert.ok(!serialized.includes(row.key_iv));
  const none = shopAiStatus({}, null);
  assert.equal(none.provider, 'workers-ai');
  assert.equal(none.label, 'Using Cloudflare AI (included)');
});

test('key format and failure classification', () => {
  assert.equal(normalizeAnthropicKey(`  ${SHOP_KEY}  `), SHOP_KEY);
  assert.throws(() => normalizeAnthropicKey(''), /Paste your Anthropic API key/);
  assert.throws(() => normalizeAnthropicKey('sk-proj-notAnAnthropicKey123456'), /sk-ant-/);
  assert.throws(() => normalizeAnthropicKey('sk-ant-has space in it 1234567'), /complete Anthropic API key/);
  assert.equal(classifyAnthropicFailure({ status: 401, type: 'authentication_error' }), 'invalid_key');
  assert.equal(classifyAnthropicFailure({ status: 403, type: 'permission_error' }), 'permission');
  assert.equal(classifyAnthropicFailure({ status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' }), 'no_credits');
  assert.equal(classifyAnthropicFailure({ status: 404, type: 'not_found_error' }), 'model_unavailable');
  assert.equal(classifyAnthropicFailure({ status: 429, type: 'rate_limit_error' }), 'rate_limited');
  assert.equal(classifyAnthropicFailure({ status: 529, type: 'overloaded_error' }), 'unavailable');
});

test('default Claude model is configurable platform-wide and per shop', () => {
  assert.equal(shopClaudeModel({}, null), 'claude-sonnet-5');
  assert.equal(shopClaudeModel({ ANTHROPIC_SONNET_MODEL: 'claude-sonnet-x' }, null), 'claude-sonnet-x');
  assert.equal(shopClaudeModel({ SHOP_ANTHROPIC_MODEL: 'claude-haiku-x', ANTHROPIC_SONNET_MODEL: 'claude-sonnet-x' }, null), 'claude-haiku-x');
  assert.equal(shopClaudeModel({ SHOP_ANTHROPIC_MODEL: 'claude-haiku-x' }, { model: 'claude-opus-x' }), 'claude-opus-x');
});

// ---- routing --------------------------------------------------------------

test('provider priority: shop key, then platform key, then Workers AI', () => {
  const ai = workersAi();
  assert.equal(selectTextProvider({ AI: ai, ANTHROPIC_API_KEY: PLATFORM_KEY }, { shopAnthropic: { apiKey: SHOP_KEY } }), 'anthropic-shop');
  assert.equal(selectTextProvider({ AI: ai, ANTHROPIC_API_KEY: PLATFORM_KEY }), 'anthropic');
  assert.equal(selectTextProvider({ AI: ai }), 'workers-ai');
  assert.equal(selectTextProvider({ AI: ai }, { shopAnthropic: null }), 'workers-ai');
  assert.equal(selectTextProvider({}), null);
});

test('a shop with its own key gets Claude with that key and its model', async () => {
  const requests = [];
  const result = await runAnthropicTurn({
    AI_ENABLED: '1',
    ANTHROPIC_API_KEY: PLATFORM_KEY,
    SHOP_ANTHROPIC_MODEL: 'claude-shop-default',
    AI: { async run() { assert.fail('Workers AI must not answer when the shop key works'); } },
  }, {
    shopId: 'shop-a',
    message: 'P0234 on a 2016 Encore?',
    shopAnthropic: { apiKey: SHOP_KEY, model: 'claude-shop-default', status: 'active' },
    fetcher: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return anthropicText('Overboost: test the wastegate.');
    },
  });
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.keySource, 'shop');
  assert.equal(result.model, 'claude-shop-default');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['x-api-key'], SHOP_KEY);
  assert.equal(requests[0].body.model, 'claude-shop-default');
  assert.deepEqual(usageCostsForResult({ ANTHROPIC_SONNET_INPUT_USD_PER_MTOK: '3', ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK: '15', AI_BILLING_MARKUP_MULTIPLIER: '2' }, result), { providerCostUsd: null, billedUsd: null });
});

test('a shop without a key stays on Workers AI even with no platform key', async () => {
  const runs = [];
  const result = await runAnthropicTurn({ AI_ENABLED: '1', AI: workersAi(runs) }, {
    shopId: 'shop-a',
    message: 'Hello',
    shopAnthropic: null,
    fetcher: async () => assert.fail('no external provider expected'),
  });
  assert.equal(result.provider, 'workers-ai');
  assert.equal(result.keySource, 'included');
  assert.equal(runs.length, 1);
  assert.equal(result.notice, undefined);
});

test('an invalid or out-of-credit shop key falls back to Workers AI with a notice and flags the key', async () => {
  for (const [response, pattern] of [
    [() => anthropicError(401, 'authentication_error', 'invalid x-api-key'), /rejected this API key/],
    [() => anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), /out of credits/],
  ]) {
    const DB = fakeDb();
    const runs = [];
    const result = await runAnthropicTurn({ AI_ENABLED: '1', AI: workersAi(runs), DB }, {
      shopId: 'shop-a',
      message: 'P0234?',
      shopAnthropic: { apiKey: SHOP_KEY, model: 'claude-sonnet-5', status: 'active' },
      fetcher: async () => response(),
    });
    assert.equal(result.provider, 'workers-ai');
    assert.equal(result.routingReason, 'shop_anthropic_failed_fallback');
    assert.equal(result.fallbackFrom, 'anthropic');
    assert.match(result.notice, pattern);
    assert.match(result.notice, /Check your key in Shop settings > AI/);
    assert.ok(!result.notice.includes(SHOP_KEY));
    assert.equal(runs.length, 1);
    const flag = DB.calls.find(call => /UPDATE shop_ai_settings/.test(call.sql));
    assert.ok(flag, 'key should be flagged');
    assert.equal(flag.args[0], 'error');
    assert.equal(flag.args.at(-1), 'shop-a');
  }
});

test('a temporary Anthropic outage falls back without flagging the shop key', async () => {
  const DB = fakeDb();
  const result = await runAnthropicTurn({ AI_ENABLED: '1', AI: workersAi(), DB }, {
    shopId: 'shop-a',
    message: 'Hi',
    shopAnthropic: { apiKey: SHOP_KEY, model: 'claude-sonnet-5', status: 'active' },
    fetcher: async () => anthropicError(529, 'overloaded_error', 'Overloaded'),
  });
  assert.equal(result.provider, 'workers-ai');
  assert.match(result.notice, /Claude was unavailable/);
  assert.equal(DB.calls.some(call => /UPDATE shop_ai_settings/.test(call.sql)), false);
});

test('a previously flagged key is marked healthy again after it works', async () => {
  const DB = fakeDb();
  await runAnthropicTurn({ AI_ENABLED: '1', AI: workersAi(), DB }, {
    shopId: 'shop-a',
    message: 'Hi',
    shopAnthropic: { apiKey: SHOP_KEY, model: 'claude-sonnet-5', status: 'error' },
    fetcher: async () => anthropicText(),
  });
  const update = DB.calls.find(call => /UPDATE shop_ai_settings/.test(call.sql));
  assert.ok(update);
  assert.equal(update.args[0], 'active');
  assert.equal(update.args[1], null);
});

test('without a Workers AI binding a failing shop key surfaces the provider error', async () => {
  await assert.rejects(runAnthropicTurn({ AI_ENABLED: '1' }, {
    shopId: 'shop-a',
    message: 'Hi',
    shopAnthropic: { apiKey: SHOP_KEY, model: 'claude-sonnet-5', status: 'active' },
    fetcher: async () => anthropicError(401, 'authentication_error'),
  }), error => error instanceof AnthropicApiError && error.status === 502);
});

test('the shop key is decrypted from D1; a missing table keeps the shop on Workers AI', async () => {
  const row = await encryptedRow();
  const config = await loadShopAnthropicConfig({ DB: fakeDb({ shopRow: row }), INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY }, 'shop-a');
  assert.equal(config.apiKey, SHOP_KEY);
  assert.equal(config.last4, '1234');
  assert.equal(await loadShopAnthropicConfig({ DB: fakeDb({ missingAiTable: true }), INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY }, 'shop-a'), null);
  assert.equal(await loadShopAnthropicConfig({ DB: fakeDb({ shopRow: row }), INTEGRATION_ENCRYPTION_KEY: 'wrong-secret' }, 'shop-a'), null);
});

test('assistant route uses the stored shop key end to end and does not bill MechPro usage', async (t) => {
  const DB = fakeDb({ shopRow: await encryptedRow() });
  const provider = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], SHOP_KEY);
    return anthropicText('Overboost means boost exceeded the commanded limit.');
  });
  const env = {
    DB,
    DEV_AUTH_BYPASS: '1',
    AI_ENABLED: '1',
    INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY,
    AI: { async run() { assert.fail('Workers AI must not answer'); } },
    ANTHROPIC_SONNET_INPUT_USD_PER_MTOK: '3',
    ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK: '15',
    AI_BILLING_MARKUP_MULTIPLIER: '2',
  };
  env.AI_CHAT_SESSIONS = chatNamespace(env);
  const response = await worker.fetch(apiRequest('/ai/assistant', 'POST', { message: 'What is P0234?' }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.keySource, 'shop');
  assert.equal(payload.provider, 'anthropic');
  assert.equal(provider.mock.callCount(), 1);
  const usage = DB.calls.find(call => /INSERT INTO ai_usage_events/.test(call.sql));
  assert.equal(usage.args[4], 'anthropic');
  assert.equal(usage.args[9], null);
  assert.equal(usage.args[10], null);
  assert.match(usage.args[11], /"keySource":"shop"/);
});

test('assistant route returns the fallback notice when the shop key fails', async (t) => {
  const DB = fakeDb({ shopRow: await encryptedRow() });
  t.mock.method(globalThis, 'fetch', async () => anthropicError(401, 'authentication_error', 'invalid x-api-key'));
  const env = { DB, DEV_AUTH_BYPASS: '1', AI_ENABLED: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY, AI: workersAi() };
  env.AI_CHAT_SESSIONS = chatNamespace(env);
  const response = await worker.fetch(apiRequest('/ai/assistant', 'POST', { message: 'What is P0234?' }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, 'workers-ai');
  assert.match(payload.message, /wastegate/);
  assert.match(payload.notice, /rejected this API key/);
});

// ---- settings route ------------------------------------------------------

test('owners save a validated key; the response is masked and the stored value is encrypted', async (t) => {
  const DB = fakeDb();
  const validation = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    validation.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return anthropicText('p');
  });
  const env = { DB, DEV_AUTH_BYPASS: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY };
  const response = await worker.fetch(apiRequest('/settings/ai', 'PUT', { apiKey: SHOP_KEY }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.saved, true);
  assert.equal(payload.provider, 'anthropic');
  assert.equal(payload.maskedKey, `${MASK}1234`);
  assert.ok(!JSON.stringify(payload).includes(SHOP_KEY));
  assert.equal(validation.length, 1);
  assert.equal(validation[0].body.max_tokens, 1);
  assert.equal(validation[0].headers['x-api-key'], SHOP_KEY);
  const insert = DB.calls.find(call => /INSERT INTO shop_ai_settings/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.args[0], 'shop-a');
  assert.ok(!insert.args.includes(SHOP_KEY), 'plaintext key must not be stored');
  assert.equal(insert.args[3], '1234');
  assert.ok(DB.calls.some(call => /INSERT INTO audit_log/.test(call.sql) && !call.args.join('|').includes(SHOP_KEY)));
});

test('an invalid key is rejected with a clear message and nothing is stored', async (t) => {
  const DB = fakeDb();
  t.mock.method(globalThis, 'fetch', async () => anthropicError(401, 'authentication_error', 'invalid x-api-key'));
  const response = await worker.fetch(apiRequest('/settings/ai', 'PUT', { apiKey: SHOP_KEY }), { DB, DEV_AUTH_BYPASS: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Anthropic rejected this API key/);
  assert.equal(DB.calls.some(call => /INSERT INTO shop_ai_settings/.test(call.sql)), false);
});

test('a key with no credits is rejected before saving', async (t) => {
  const DB = fakeDb();
  t.mock.method(globalThis, 'fetch', async () => anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'));
  const response = await worker.fetch(apiRequest('/settings/ai', 'PUT', { apiKey: SHOP_KEY }), { DB, DEV_AUTH_BYPASS: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /out of credits/);
});

test('technicians cannot save or remove the key but can see the status', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no validation call for unauthorized users'));
  const env = { DB: fakeDb({ role: 'technician', shopRow: await encryptedRow() }), DEV_AUTH_BYPASS: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY };
  assert.equal((await worker.fetch(apiRequest('/settings/ai', 'PUT', { apiKey: SHOP_KEY }), env)).status, 403);
  assert.equal((await worker.fetch(apiRequest('/settings/ai', 'DELETE'), env)).status, 403);
  const status = await worker.fetch(apiRequest('/settings/ai'), env);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.label, `Using Claude with your key ${MASK}1234`);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('owners can remove the key and the shop returns to Cloudflare AI', async () => {
  const DB = fakeDb({ shopRow: await encryptedRow() });
  const response = await worker.fetch(apiRequest('/settings/ai', 'DELETE'), { DB, DEV_AUTH_BYPASS: '1', INTEGRATION_ENCRYPTION_KEY: ENCRYPTION_KEY });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.removed, true);
  assert.equal(payload.label, 'Using Cloudflare AI (included)');
  assert.ok(DB.calls.some(call => /DELETE FROM shop_ai_settings WHERE shop_id = \?/.test(call.sql) && call.args[0] === 'shop-a'));
});

test('status falls back to the included AI before the migration is applied', async () => {
  const response = await worker.fetch(apiRequest('/settings/ai'), { DB: fakeDb({ missingAiTable: true }), DEV_AUTH_BYPASS: '1' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).label, 'Using Cloudflare AI (included)');
});

test('key validation treats rate limits as a working key and network errors as unavailable', async () => {
  assert.deepEqual(await validateAnthropicKey(SHOP_KEY, { fetcher: async () => anthropicText() }), { ok: true });
  assert.equal((await validateAnthropicKey(SHOP_KEY, { fetcher: async () => anthropicError(429, 'rate_limit_error') })).ok, true);
  assert.deepEqual(await validateAnthropicKey(SHOP_KEY, { fetcher: async () => { throw new Error('offline'); } }), { ok: false, kind: 'unavailable' });
});