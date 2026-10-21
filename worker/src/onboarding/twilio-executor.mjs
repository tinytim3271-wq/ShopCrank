// Runs a Twilio request plan. Dry-run (the default) never calls fetch; it only
// resolves what would be sent. Live runs need ONBOARDING_LIVE_MODE=1 and the
// credentials resolved at execution time; results are recorded per request so a
// partly finished plan resumes instead of repeating paid requests.

import { TWILIO_BASES } from './twilio-plans.mjs';

export class OnboardingBlockedError extends Error {
  constructor(message, code = 'blocked') {
    super(message);
    this.name = 'OnboardingBlockedError';
    this.code = code;
  }
}

export function liveModeEnabled(env) {
  return String(env?.ONBOARDING_LIVE_MODE || '') === '1';
}

export function masterCredentials(env) {
  const accountSid = String(env?.TWILIO_MASTER_ACCOUNT_SID || '').trim();
  const authToken = String(env?.TWILIO_MASTER_AUTH_TOKEN || '').trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

function basicAuth({ accountSid, authToken }) {
  const bytes = new TextEncoder().encode(`${accountSid}:${authToken}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function resolveRefs(value, results) {
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, results));
  if (typeof value !== 'string') return value;
  return value.replace(/\$ref:([a-z_]+)\.([a-z_]+)/gi, (match, key, field) => {
    const resolved = results[key]?.[field];
    if (resolved === undefined || resolved === null || resolved === '') throw new OnboardingBlockedError(`Missing ${key}.${field} from an earlier request`, 'missing_ref');
    return String(resolved);
  });
}

function encodeForm(form) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form || {})) {
    if (Array.isArray(value)) for (const item of value) body.append(key, item);
    else body.append(key, value ?? '');
  }
  return body;
}

export function buildRequest(item, results, { masterSid = '' } = {}) {
  const path = resolveRefs(item.path, results).replace('{master}', masterSid || '{master}');
  const query = item.query ? `?${new URLSearchParams(item.query).toString()}` : '';
  return {
    url: `${TWILIO_BASES[item.base]}${path}${query}`,
    method: item.method,
    body: item.form ? encodeForm(Object.fromEntries(Object.entries(item.form).map(([key, value]) => [key, resolveRefs(value, results)]))) : null,
  };
}

const KEEP_FIELDS = ['sid', 'status', 'campaign_status', 'friendly_name', 'phone_number', 'auth_token', 'date_created', 'duration', 'errors', 'failure_reason', 'brand_score', 'identity_status', 'tcr_id', 'results', 'calls', 'alerts', 'valid', 'available_phone_numbers'];

function keepUseful(payload) {
  const result = {};
  for (const field of KEEP_FIELDS) if (payload?.[field] !== undefined) result[field] = payload[field];
  return result;
}

/**
 * @param credentials { master, subaccount } — each { accountSid, authToken } or null
 * @param previous    results from an earlier partial live run (skipped on resume)
 */
export async function executePlan(env, requests, { mode = 'dry_run', credentials = {}, previous = {}, fetcher = fetch, onResult = null } = {}) {
  if (mode !== 'live') {
    const preview = {};
    return {
      mode: 'dry_run',
      calledTwilio: false,
      requests: requests.map(item => {
        const placeholderResults = new Proxy(preview, { get: (_, key) => ({ sid: `<${String(key)}.sid>`, phone_number: `<${String(key)}.phone_number>` }) });
        const built = buildRequest(item, placeholderResults, { masterSid: credentials.master?.accountSid ? '<master>' : '{master}' });
        return { key: item.key, method: built.method, url: built.url, form: built.body ? Object.fromEntries(built.body) : null, account: item.account };
      }),
    };
  }
  if (!liveModeEnabled(env)) throw new OnboardingBlockedError('Live onboarding is disabled. Set ONBOARDING_LIVE_MODE=1 on the Worker to allow live Twilio calls.', 'live_mode_disabled');
  const results = { ...previous };
  for (const item of requests) {
    if (results[item.key]?.sid && item.method !== 'GET') continue;
    const creds = credentials[item.account];
    if (!creds) throw new OnboardingBlockedError(`Missing ${item.account} Twilio credentials`, 'missing_credentials');
    const built = buildRequest(item, results, { masterSid: credentials.master?.accountSid });
    const response = await fetcher(built.url, {
      method: built.method,
      headers: {
        Authorization: basicAuth(creds),
        ...(built.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(built.body ? { body: built.body.toString() } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new OnboardingBlockedError(`Twilio rejected ${item.key}: ${payload?.message || `HTTP ${response.status}`} (code ${payload?.code || 'n/a'})`, 'twilio_error');
      error.results = results;
      error.failedKey = item.key;
      throw error;
    }
    results[item.key] = keepUseful(payload);
    if (typeof onResult === 'function') await onResult(item.key, results[item.key], results);
  }
  return { mode: 'live', calledTwilio: true, results };
}

/** Strip secrets before results are written to onboarding state. */
export function publicResults(results = {}) {
  return Object.fromEntries(Object.entries(results).map(([key, value]) => {
    const { auth_token: _authToken, ...rest } = value || {};
    return [key, rest];
  }));
}
