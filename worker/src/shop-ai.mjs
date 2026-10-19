import { HttpError, json, requestJson } from './http.mjs';
import { decryptSecret, encryptSecret } from './security.mjs';

// Per-shop "bring your own AI key" upgrade.
//
// Routing order for text AI (see runAnthropicTurn in ai.mjs):
//   1. The shop's own provider key (stored encrypted in shop_ai_settings).
//   2. Platform provider secrets (optional overrides).
//   3. Cloudflare Workers AI (the included default).
// A failing shop key falls back to Workers AI and returns a notice for the shop.

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';
export const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_CONSOLE_KEYS_URL = 'https://aistudio.google.com/app/apikey';

// Default models for shops that bring their own keys.
export const DEFAULT_SHOP_CLAUDE_MODEL = 'claude-sonnet-5';
export const DEFAULT_SHOP_GEMINI_MODEL = 'gemini-3.8-flash';

const MASK = '\u2022\u2022\u2022\u2022';
const MANAGE_ROLES = ['owner', 'admin', 'super_admin'];
const VIEW_ROLES = ['owner', 'admin', 'office', 'service_writer', 'technician'];
const KEY_PROBLEMS = new Set(['invalid_key', 'permission', 'no_credits', 'model_unavailable']);

const ANTHROPIC_FAILURE_MESSAGES = Object.freeze({
  invalid_key: 'Anthropic rejected this API key. Check that you copied the whole key from console.anthropic.com and that it has not been revoked.',
  permission: 'This Anthropic API key is not allowed to use the Claude API. Check the key\'s workspace permissions at console.anthropic.com.',
  no_credits: 'Your Anthropic account is out of credits or has no billing set up. Add credits at console.anthropic.com under Billing.',
  model_unavailable: 'This Anthropic account cannot use the selected Claude model.',
  rate_limited: 'Anthropic is rate-limiting this key right now.',
  unavailable: 'Anthropic could not be reached right now.',
});

const GEMINI_FAILURE_MESSAGES = Object.freeze({
  invalid_key: 'Google Gemini rejected this API key. Check that you copied the whole key from aistudio.google.com.',
  permission: 'This Google Gemini API key is not allowed to use the selected model.',
  no_credits: 'Your Google Gemini project does not have billing or quota available.',
  model_unavailable: 'This Google Gemini API key cannot use the selected Gemini model.',
  rate_limited: 'Google Gemini is rate-limiting this key right now.',
  unavailable: 'Google Gemini could not be reached right now.',
});

export function keyLast4(key) {
  const value = String(key || '').trim();
  return value.length >= 8 ? value.slice(-4) : '';
}

export function maskApiKey(key) {
  const value = String(key || '').trim();
  return value ? `${MASK}${keyLast4(value)}` : '';
}

export function normalizeShopAiProvider(value) {
  const provider = String(value || 'gemini').trim().toLowerCase();
  if (!['anthropic', 'gemini'].includes(provider)) {
    throw new HttpError(400, 'provider must be "anthropic" or "gemini"');
  }
  return provider;
}

function includedProvider(env = {}) {
  const preferred = String(env.AI_TEXT_PROVIDER || 'gemini').trim().toLowerCase();
  const hasAnthropic = String(env.ANTHROPIC_API_KEY || '').trim().length > 0;
  const hasGemini = String(env.GEMINI_API_KEY || '').trim().length > 0;
  if (hasGemini && (preferred === 'gemini' || !hasAnthropic)) return 'gemini';
  if (hasAnthropic) return 'anthropic';
  if (env.AI && typeof env.AI.run === 'function') return 'workers-ai';
  return 'workers-ai';
}

export function normalizeAnthropicKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new HttpError(400, 'Paste your Anthropic API key.');
  if (/\s/.test(key) || key.length < 20 || key.length > 300) {
    throw new HttpError(400, 'That does not look like a complete Anthropic API key. Copy the whole key from console.anthropic.com.');
  }
  if (!key.startsWith('sk-ant-')) {
    throw new HttpError(400, 'Anthropic API keys start with "sk-ant-". Create one at console.anthropic.com under API keys.');
  }
  return key;
}

export function normalizeGeminiKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new HttpError(400, 'Paste your Google Gemini API key.');
  if (/\s/.test(key) || key.length < 20 || key.length > 300) {
    throw new HttpError(400, 'That does not look like a complete Google Gemini API key. Copy the whole key from aistudio.google.com.');
  }
  if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) {
    throw new HttpError(400, 'Google Gemini API keys usually start with "AIza". Create one at aistudio.google.com/apikey.');
  }
  return key;
}

export function normalizeProviderApiKey(provider, value) {
  return provider === 'gemini' ? normalizeGeminiKey(value) : normalizeAnthropicKey(value);
}

export function normalizeClaudeModel(value) {
  const model = String(value || '').trim();
  if (!model) return '';
  if (!/^claude-[a-z0-9][a-z0-9.-]{1,80}$/.test(model)) {
    throw new HttpError(400, 'model must be a Claude model id such as claude-sonnet-5');
  }
  return model;
}

export function normalizeGeminiModel(value) {
  const model = String(value || '').trim();
  if (!model) return '';
  if (!/^gemini-[a-z0-9][a-z0-9.-]{1,100}$/.test(model)) {
    throw new HttpError(400, 'model must be a Gemini model id such as gemini-3.8-flash');
  }
  return model;
}

export function normalizeProviderModel(provider, value) {
  return provider === 'gemini' ? normalizeGeminiModel(value) : normalizeClaudeModel(value);
}

export function shopClaudeModel(env = {}, settings = null) {
  return String(settings?.model || env.SHOP_ANTHROPIC_MODEL || env.ANTHROPIC_SONNET_MODEL || DEFAULT_SHOP_CLAUDE_MODEL);
}

export function shopGeminiModel(env = {}, settings = null) {
  return String(settings?.model || env.SHOP_GEMINI_MODEL || env.GEMINI_MODEL || DEFAULT_SHOP_GEMINI_MODEL);
}

export function classifyAnthropicFailure({ status = 0, type = '', message = '' } = {}) {
  const text = `${type} ${message}`.toLowerCase();
  if (status === 401 || type === 'authentication_error') return 'invalid_key';
  if (status === 403 || type === 'permission_error') return 'permission';
  if (/credit balance|billing|purchase credits|insufficient (?:credit|fund|balance)/.test(text)) return 'no_credits';
  if (status === 404 || type === 'not_found_error') return 'model_unavailable';
  if (status === 429 || type === 'rate_limit_error') return 'rate_limited';
  return 'unavailable';
}

export function classifyGeminiFailure({ status = 0, type = '', message = '' } = {}) {
  const text = `${type} ${message}`.toLowerCase();
  if (status === 400 && /(api[_\s-]?key|invalid argument|malformed|credentials?)/.test(text)) return 'invalid_key';
  if (status === 401 || status === 403 || /(permission|access denied|forbidden|auth)/.test(text)) return 'permission';
  if (/quota|billing|insufficient|credit|payment/.test(text)) return 'no_credits';
  if (status === 404 || /(not found|model)/.test(text)) return 'model_unavailable';
  if (status === 429 || /rate|resource exhausted/.test(text)) return 'rate_limited';
  return 'unavailable';
}

export function isShopKeyProblem(kind) {
  return KEY_PROBLEMS.has(kind);
}

export function anthropicFailureMessage(kind) {
  return ANTHROPIC_FAILURE_MESSAGES[kind] || ANTHROPIC_FAILURE_MESSAGES.unavailable;
}

export function geminiFailureMessage(kind) {
  return GEMINI_FAILURE_MESSAGES[kind] || GEMINI_FAILURE_MESSAGES.unavailable;
}

export function providerFailureMessage(provider, kind) {
  return provider === 'gemini' ? geminiFailureMessage(kind) : anthropicFailureMessage(kind);
}

export class AnthropicApiError extends HttpError {
  constructor({ status = 0, type = '', message = '' } = {}) {
    super(502, 'The ShopCrank assistant provider is unavailable');
    this.name = 'AnthropicApiError';
    this.upstreamStatus = status;
    this.upstreamType = type;
    this.kind = classifyAnthropicFailure({ status, type, message });
  }
}

export class GeminiApiError extends HttpError {
  constructor({ status = 0, type = '', message = '' } = {}) {
    super(502, 'The ShopCrank assistant provider is unavailable');
    this.name = 'GeminiApiError';
    this.upstreamStatus = status;
    this.upstreamType = type;
    this.kind = classifyGeminiFailure({ status, type, message });
  }
}

/** One-token Messages call: proves the key authenticates, has credits, and can use the model. */
export async function validateAnthropicKey(apiKey, { model = DEFAULT_SHOP_CLAUDE_MODEL, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
  } catch {
    return { ok: false, kind: 'unavailable' };
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({}));
  const kind = classifyAnthropicFailure({
    status: response.status,
    type: body?.error?.type || '',
    message: body?.error?.message || '',
  });
  if (kind === 'rate_limited') return { ok: true, warning: anthropicFailureMessage(kind) };
  return { ok: false, kind };
}

export async function validateGeminiKey(apiKey, { model = DEFAULT_SHOP_GEMINI_MODEL, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(`${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 },
      }),
    });
    if (response.status === 404) {
      response = await fetcher(GEMINI_INTERACTIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model,
          input: 'ping',
        }),
      });
    }
  } catch {
    return { ok: false, kind: 'unavailable' };
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({}));
  const message = body?.error?.message || body?.message || '';
  const kind = classifyGeminiFailure({
    status: response.status,
    type: body?.error?.status || '',
    message,
  });
  if (kind === 'rate_limited') return { ok: true, warning: geminiFailureMessage(kind) };
  return { ok: false, kind };
}

const SELECT_SETTINGS_SQL = `SELECT shop_id, provider, key_ciphertext, key_iv, key_last4, model, status, last_error, last_error_at,
  validated_at, updated_at FROM shop_ai_settings WHERE shop_id = ?`;

function isMissingTable(error) {
  return /no such table/i.test(String(error?.message || error));
}

/**
 * Reads the shop's AI row. Never throws: a missing table (migration not yet
 * applied) or a D1 hiccup leaves the shop on the included Workers AI path.
 */
export async function readShopAiSettings(env, shopId) {
  if (!shopId || !env?.DB) return null;
  try {
    return (await env.DB.prepare(SELECT_SETTINGS_SQL).bind(shopId).first()) || null;
  } catch (error) {
    console.warn(JSON.stringify({
      message: 'Shop AI settings unavailable; using the included AI',
      error: String(error?.message || error).slice(0, 200),
    }));
    return null;
  }
}

/** Decrypted key for the AI request path, or null when the shop has none. */
export async function loadShopProviderConfig(env, shopId, preferredProvider = null) {
  const row = await readShopAiSettings(env, shopId);
  if (!row?.key_ciphertext) return null;
  const provider = normalizeShopAiProvider(row.provider || preferredProvider || 'gemini');
  if (preferredProvider && provider !== preferredProvider) return null;
  try {
    const apiKey = await decryptSecret(row.key_ciphertext, row.key_iv, env.INTEGRATION_ENCRYPTION_KEY);
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      model: provider === 'gemini' ? shopGeminiModel(env, row) : shopClaudeModel(env, row),
      last4: row.key_last4 || '',
      status: row.status || 'active',
    };
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Shop provider key could not be decrypted; using the included AI',
      shopId,
      error: String(error?.message || error).slice(0, 200),
    }));
    return null;
  }
}

export async function loadShopAnthropicConfig(env, shopId) {
  return loadShopProviderConfig(env, shopId, 'anthropic');
}

export async function saveShopProviderKey(env, shopId, { provider = 'gemini', apiKey, model = '', userId = null }) {
  const encrypted = await encryptSecret(apiKey, env.INTEGRATION_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO shop_ai_settings (
      shop_id, provider, key_ciphertext, key_iv, key_last4, model, status,
      last_error, last_error_at, validated_at, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      provider = excluded.provider,
      key_ciphertext = excluded.key_ciphertext,
      key_iv = excluded.key_iv,
      key_last4 = excluded.key_last4,
      model = excluded.model,
      status = 'active',
      last_error = NULL,
      last_error_at = NULL,
      validated_at = excluded.validated_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(shopId, provider, encrypted.ciphertext, encrypted.iv, keyLast4(apiKey), model || null, now, now, now, userId).run();
  return {
    shop_id: shopId,
    provider,
    key_ciphertext: encrypted.ciphertext,
    key_last4: keyLast4(apiKey),
    model: model || null,
    status: 'active',
    validated_at: now,
    updated_at: now,
  };
}

export async function saveShopAnthropicKey(env, shopId, { apiKey, model = '', userId = null }) {
  return saveShopProviderKey(env, shopId, { provider: 'anthropic', apiKey, model, userId });
}

export async function deleteShopAnthropicKey(env, shopId) {
  try {
    await env.DB.prepare('DELETE FROM shop_ai_settings WHERE shop_id = ?').bind(shopId).run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

/** Records whether the shop key last worked. Best effort: never breaks an AI answer. */
export async function markShopKeyStatus(env, shopId, { status, error = null }) {
  if (!shopId || !env?.DB) return;
  try {
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE shop_ai_settings
      SET status = ?, last_error = ?, last_error_at = ?, updated_at = ?
      WHERE shop_id = ?
    `).bind(status, error, error ? now : null, now, shopId).run();
  } catch (caught) {
    console.warn(JSON.stringify({ message: 'Could not update shop AI key status', error: String(caught?.message || caught).slice(0, 200) }));
  }
}

/** Client-safe status. Never includes the key or its ciphertext. */
export function shopAiStatus(env = {}, row = null) {
  const hasKey = Boolean(row?.key_ciphertext);
  const provider = hasKey ? normalizeShopAiProvider(row.provider || 'gemini') : includedProvider(env);
  const last4 = hasKey ? String(row.key_last4 || '') : '';
  const maskedKey = hasKey ? `${MASK}${last4}` : '';
  const keyError = hasKey && row.status === 'error';
  return {
    provider,
    hasKey,
    maskedKey,
    keyLast4: last4,
    model: hasKey ? (provider === 'gemini' ? shopGeminiModel(env, row) : shopClaudeModel(env, row)) : null,
    claudeModel: hasKey && provider === 'anthropic' ? shopClaudeModel(env, row) : null,
    geminiModel: hasKey && provider === 'gemini' ? shopGeminiModel(env, row) : null,
    status: hasKey ? (keyError ? 'key_error' : 'active') : 'included',
    lastError: keyError ? String(row.last_error || '') : '',
    lastErrorAt: keyError ? row.last_error_at || null : null,
    validatedAt: hasKey ? row.validated_at || null : null,
    label: hasKey
      ? (provider === 'gemini' ? `Using Gemini with your key ${maskedKey}` : `Using Claude with your key ${maskedKey}`)
      : (provider === 'gemini' ? 'Using Gemini (included)' : provider === 'anthropic' ? 'Using Claude (included)' : 'Using Cloudflare AI (included)'),
    includedProvider: hasKey ? null : provider,
    consoleUrl: provider === 'anthropic' ? ANTHROPIC_CONSOLE_KEYS_URL : GEMINI_CONSOLE_KEYS_URL,
  };
}

function requireAnyRole(context, roles) {
  if (!roles.includes(context?.role)) {
    throw new HttpError(403, 'Only shop owners and admins can manage the shop AI key');
  }
}

/** GET/PUT/POST/DELETE /settings/ai */
export async function handleShopAiSettings(request, env, context, { fetcher = fetch, recordAudit = null } = {}) {
  if (!context?.shopId || context.shopId === 'platform') throw new HttpError(400, 'Open a shop to manage its AI settings');
  const shopId = context.shopId;

  if (request.method === 'GET') {
    if (!VIEW_ROLES.includes(context.role)) throw new HttpError(403, `Role ${context.role} is not permitted for this action`);
    return json(shopAiStatus(env, await readShopAiSettings(env, shopId)));
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    requireAnyRole(context, MANAGE_ROLES);
    if (!env.INTEGRATION_ENCRYPTION_KEY) {
      throw new HttpError(503, 'Shop API key storage is not configured on the Worker (INTEGRATION_ENCRYPTION_KEY is missing)');
    }
    const body = await requestJson(request);
    const provider = normalizeShopAiProvider(body.provider || 'gemini');
    const apiKey = normalizeProviderApiKey(provider, body.apiKey);
    const model = normalizeProviderModel(provider, body.model);
    const check = provider === 'gemini'
      ? await validateGeminiKey(apiKey, { model: model || shopGeminiModel(env, null), fetcher })
      : await validateAnthropicKey(apiKey, { model: model || shopClaudeModel(env, null), fetcher });
    if (!check.ok) {
      if (check.kind === 'unavailable') {
        throw new HttpError(502, `Could not reach ${provider === 'gemini' ? 'Google Gemini' : 'Anthropic'} to check the key. Nothing was saved; try again in a minute.`);
      }
      throw new HttpError(400, providerFailureMessage(provider, check.kind));
    }
    let row;
    try {
      row = await saveShopProviderKey(env, shopId, { provider, apiKey, model, userId: context.userId || null });
    } catch (error) {
      if (isMissingTable(error)) {
        throw new HttpError(503, 'Shop AI key storage is not set up yet (D1 migration 0009_shop_ai_settings.sql is pending).');
      }
      throw error;
    }
    await recordAudit?.(env, context, { kind: `settings.ai.${provider}_key.saved`, keyLast4: row.key_last4 });
    return json({ ...shopAiStatus(env, row), saved: true, ...(check.warning ? { warning: check.warning } : {}) });
  }

  if (request.method === 'DELETE') {
    requireAnyRole(context, MANAGE_ROLES);
    await deleteShopAnthropicKey(env, shopId);
    await recordAudit?.(env, context, { kind: 'settings.ai.key.removed' });
    return json({ ...shopAiStatus(env, null), removed: true });
  }

  throw new HttpError(405, 'Method not allowed');
}
