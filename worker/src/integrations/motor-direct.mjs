import { mapMotorLaborOperationToEstimateLine } from '../../../src/modules/labor-guide.js';
import { validateProviderBaseUrl } from './labor.mjs';

/**
 * Direct MOTOR labor adapter (MOTOR Data-as-a-Service).
 *
 * Credentials come from either the shop's own MOTOR keys (stored encrypted as
 * the labor-guide secret) or a ShopCrank platform license in Worker env vars.
 * MOTOR issues the base URL, labor path, and key pair at onboarding, so none of
 * them are hard-coded: MOTOR_API_BASE_URL + MOTOR_LABOR_PATH (with {vin},
 * {keyword} placeholders) + MOTOR_PUBLIC_KEY / MOTOR_PRIVATE_KEY.
 *
 * Auth defaults to MOTOR's "Shared" HMAC scheme:
 *   Authorization: Shared <publicKey>:<base64(HMAC-SHA256(privateKey,
 *     "<publicKey>\n<METHOD>\n<epochSeconds>\n<path>"))>
 * plus an X-Date header carrying the epoch seconds. Set MOTOR_AUTH_SCHEME=bearer
 * if the account was provisioned with a bearer token instead.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OPERATIONS = 50;

function text(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

export function motorPlatformConfig(env = {}) {
  return motorConfig(env, {
    publicKey: env.MOTOR_PUBLIC_KEY,
    privateKey: env.MOTOR_PRIVATE_KEY,
    bearerToken: env.MOTOR_API_TOKEN,
  });
}

export function motorShopConfig(env = {}, record = {}) {
  return motorConfig(env, {
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    bearerToken: record.apiKey,
  });
}

function motorConfig(env, { publicKey, privateKey, bearerToken }) {
  const baseUrl = text(env.MOTOR_API_BASE_URL, 500);
  const laborPath = text(env.MOTOR_LABOR_PATH, 500);
  const scheme = text(env.MOTOR_AUTH_SCHEME || 'shared', 20).toLowerCase();
  const hasCredential = scheme === 'bearer' ? Boolean(text(bearerToken)) : Boolean(text(publicKey) && text(privateKey));
  return {
    baseUrl,
    laborPath,
    scheme,
    publicKey: text(publicKey, 200),
    privateKey: text(privateKey, 500),
    bearerToken: text(bearerToken, 500),
    configured: Boolean(baseUrl && laborPath && hasCredential),
  };
}

async function hmacBase64(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function motorAuthHeaders(config, { method, path, epochSeconds = Math.floor(Date.now() / 1000) }) {
  if (config.scheme === 'bearer') return { Authorization: `Bearer ${config.bearerToken}` };
  const signature = await hmacBase64(config.privateKey, `${config.publicKey}\n${method}\n${epochSeconds}\n${path}`);
  return { Authorization: `Shared ${config.publicKey}:${signature}`, 'X-Date': String(epochSeconds) };
}

export function motorLaborUrl(config, { vin = '', keyword = '' } = {}) {
  const base = validateProviderBaseUrl(config.baseUrl, 'MOTOR base URL');
  const path = config.laborPath
    .replaceAll('{vin}', encodeURIComponent(vin))
    .replaceAll('{keyword}', encodeURIComponent(keyword));
  const url = new URL(path.replace(/^\/+/, ''), `${base.toString().replace(/\/?$/, '/')}`);
  if (url.origin !== base.origin) throw new TypeError('MOTOR labor path must be relative to its base URL');
  if (keyword && !config.laborPath.includes('{keyword}')) url.searchParams.set('searchTerm', keyword);
  return url;
}

function operationList(payload) {
  const candidates = [
    payload, payload?.Body, payload?.body, payload?.Items, payload?.items, payload?.operations,
    payload?.laborOperations, payload?.LaborOperations, payload?.results, payload?.Body?.Items, payload?.data,
  ];
  return candidates.find(Array.isArray) || [];
}

/** MOTOR responses vary by product; accept the common PascalCase and camelCase shapes. */
export function normalizeMotorOperation(item = {}) {
  const hours = Number(item.BaseLaborTime ?? item.baseLaborTime ?? item.LaborTime ?? item.laborTime ?? item.baseTime ?? item.hours ?? item.Hours ?? item.time);
  if (!Number.isFinite(hours) || hours < 0 || hours > 1_000) return null;
  return {
    id: text(item.ID ?? item.Id ?? item.id ?? item.OperationID ?? item.operationId, 120) || undefined,
    operationId: text(item.OperationID ?? item.operationId ?? item.ID ?? item.id, 120) || null,
    description: text(item.Description ?? item.description ?? item.Name ?? item.name ?? item.Literal, 300) || 'Labor operation',
    notes: text(item.Notes ?? item.notes ?? item.Qualifier ?? item.application, 500),
    hours,
    category: text(item.Group ?? item.group ?? item.Category ?? item.category, 120) || null,
  };
}

export async function searchMotorLabor(config, { vin, keyword, laborRate = 0, source = 'motor' }, { fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!config.configured) throw new Error('MOTOR is not configured');
  const url = motorLaborUrl(config, { vin, keyword });
  const headers = { Accept: 'application/json', ...(await motorAuthHeaders(config, { method: 'GET', path: url.pathname })) };
  const response = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = new Error(`MOTOR labor lookup returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const operations = operationList(payload).slice(0, MAX_OPERATIONS).map(normalizeMotorOperation).filter(Boolean);
  const lines = operations.map((operation, index) => {
    const line = mapMotorLaborOperationToEstimateLine(operation, { laborRate, provider: 'motor' }, index);
    return { ...line, laborGuide: { ...line.laborGuide, bookTime: true, licensedBy: source } };
  });
  return { operations, lines };
}
