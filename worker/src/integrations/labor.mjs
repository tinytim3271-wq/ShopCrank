const MAX_QUERY_LENGTH = 500;
const MAX_TEXT_LENGTH = 120;
const MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 8_000;

export class LaborProviderError extends Error {
  constructor(provider, message, options = {}) {
    super(`${provider}: ${message}`, options);
    this.name = 'LaborProviderError';
    this.provider = provider;
    if (options.status) this.status = options.status;
  }
}

export const LABOR_PROVIDER_REGISTRY = Object.freeze({
  motor: Object.freeze({
    id: 'motor',
    provider: 'MOTOR',
    envPrefix: 'MOTOR_LABOR',
  }),
  alldata: Object.freeze({
    id: 'alldata',
    provider: 'ALLDATA',
    envPrefix: 'ALLDATA_LABOR',
  }),
});

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function timeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 100), 30_000) : DEFAULT_TIMEOUT_MS;
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateProviderBaseUrl(value, label = 'provider base URL') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new TypeError(`${label} must use HTTPS (HTTP is allowed only for localhost)`);
  }
  url.username = '';
  url.password = '';
  return url;
}

function providerConfig(env, spec) {
  const prefix = spec.envPrefix;
  const vendorPrefix = spec.provider;
  const baseUrl = env?.[`${prefix}_BASE_URL`] || env?.[`${vendorPrefix}_BASE_URL`] || '';
  const path = env?.[`${prefix}_SEARCH_PATH`]
    || env?.[`${vendorPrefix}_LABOR_SEARCH_PATH`]
    || env?.[`${vendorPrefix}_SEARCH_PATH`]
    || '';
  const apiKey = env?.[`${prefix}_API_KEY`]
    || env?.[`${prefix}_TOKEN`]
    || env?.[`${vendorPrefix}_API_KEY`]
    || env?.[`${vendorPrefix}_TOKEN`]
    || '';
  const username = env?.[`${prefix}_USERNAME`] || env?.[`${vendorPrefix}_USERNAME`] || '';
  const password = env?.[`${prefix}_PASSWORD`] || env?.[`${vendorPrefix}_PASSWORD`] || '';
  const hasCredential = Boolean(apiKey || (username && password));
  const licenseConfirmed = String(
    env?.[`${prefix}_LICENSE_CONFIRMED`] ?? env?.[`${vendorPrefix}_LABOR_LICENSE_CONFIRMED`] ?? '',
  ).toLowerCase() === 'true';
  return {
    baseUrl,
    path,
    apiKey,
    username,
    password,
    authHeader: cleanText(
      env?.[`${prefix}_AUTH_HEADER`] || env?.[`${vendorPrefix}_AUTH_HEADER`] || 'Authorization',
      80,
    ),
    authScheme: cleanText(
      env?.[`${prefix}_AUTH_SCHEME`] ?? env?.[`${vendorPrefix}_AUTH_SCHEME`] ?? 'Bearer',
      40,
    ),
    method: cleanText(
      env?.[`${prefix}_SEARCH_METHOD`] || env?.[`${vendorPrefix}_SEARCH_METHOD`] || 'POST',
      8,
    ).toUpperCase(),
    credentialsConfigured: Boolean(baseUrl && path && hasCredential),
    licenseConfirmed,
    configured: Boolean(baseUrl && path && hasCredential && licenseConfirmed),
  };
}

export function getLaborProviderStatus(env = {}) {
  return Object.fromEntries(Object.values(LABOR_PROVIDER_REGISTRY).map((spec) => {
    const config = providerConfig(env, spec);
    let configurationError = null;
    if (config.baseUrl) {
      try {
        validateProviderBaseUrl(config.baseUrl, `${spec.provider} base URL`);
      } catch (error) {
        configurationError = error.message;
      }
    }
    return [spec.id, {
      provider: spec.provider,
      configured: config.configured && !configurationError,
      credentialsConfigured: config.credentialsConfigured && !configurationError,
      licenseConfirmed: config.licenseConfirmed,
      hasPunchout: false,
      configurationError,
    }];
  }));
}

export function normalizeLaborSearchInput(input = {}) {
  const yearText = cleanText(input.year, 4);
  const year = yearText ? Number(yearText) : null;
  if (yearText && (!Number.isInteger(year) || year < 1886 || year > 2200)) {
    throw new TypeError('year must be a valid four-digit vehicle year');
  }

  const normalized = {
    vin: cleanText(input.vin, 17).toUpperCase(),
    year,
    make: cleanText(input.make),
    model: cleanText(input.model),
    engine: cleanText(input.engine),
    query: cleanText(input.query, MAX_QUERY_LENGTH),
  };
  if (!Object.values(normalized).some(Boolean)) {
    throw new TypeError('At least one labor search field is required');
  }
  return normalized;
}

function buildHeaders(config) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers[config.authHeader] = config.authScheme
      ? `${config.authScheme} ${config.apiKey}`
      : String(config.apiKey);
  } else {
    headers.Authorization = `Basic ${btoa(`${config.username}:${config.password}`)}`;
  }
  return headers;
}

function responseItems(payload) {
  const candidates = [
    payload,
    payload?.results,
    payload?.items,
    payload?.data,
    payload?.operations,
    payload?.laborOperations,
    payload?.data?.results,
    payload?.data?.items,
    payload?.data?.operations,
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeResult(item, provider) {
  if (!item || typeof item !== 'object') return null;
  const rawHours = item.hours ?? item.laborHours ?? item.standardHours ?? item.time;
  const hours = Number(rawHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 1_000) return null;
  const description = cleanText(
    item.description ?? item.name ?? item.operation ?? item.title,
    300,
  );
  return {
    hours,
    source: cleanText(item.source, 120) || provider,
    provider,
    verified: true,
    ...(description ? { description } : {}),
  };
}

export function unverifiedLaborEstimate() {
  return {
    hours: null,
    source: 'Unverified shop estimate',
    provider: null,
    verified: false,
  };
}

function endpointUrl(config, provider) {
  const base = validateProviderBaseUrl(config.baseUrl, `${provider} base URL`);
  const url = new URL(config.path.replace(/^\/+/, ''), `${base.toString().replace(/\/?$/, '/')}`);
  if (url.origin !== base.origin) {
    throw new TypeError(`${provider} search path must be relative to its base URL`);
  }
  return url;
}

/**
 * Queries configured licensed labor providers using a configurable endpoint.
 *
 * Contract assumption: the configured search endpoint accepts normalized JSON
 * (`vin`, `year`, `make`, `model`, `engine`, `query`) via POST by default.
 * Set `<PREFIX>_SEARCH_METHOD=GET` to send those values as query parameters.
 * No vendor-specific path or response contract is assumed; common result arrays
 * and hour field names are accepted defensively.
 */
export async function searchLicensedLabor(env, input, options = {}) {
  const normalized = normalizeLaborSearchInput(input);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const requested = cleanText(options.provider || env?.LABOR_PROVIDER, 20).toLowerCase();
  const specs = requested
    ? [LABOR_PROVIDER_REGISTRY[requested]].filter(Boolean)
    : Object.values(LABOR_PROVIDER_REGISTRY);
  if (requested && specs.length === 0) throw new TypeError(`Unknown labor provider: ${requested}`);

  for (const spec of specs) {
    const config = providerConfig(env, spec);
    if (!config.configured) continue;

    let url;
    try {
      url = endpointUrl(config, spec.provider);
    } catch (error) {
      throw new LaborProviderError(spec.provider, error.message, { cause: error });
    }
    const init = {
      method: config.method,
      headers: buildHeaders(config),
      signal: options.signal || AbortSignal.timeout(timeoutMs(options.timeoutMs ?? env?.LABOR_PROVIDER_TIMEOUT_MS)),
    };
    if (config.method === 'GET') {
      for (const [key, value] of Object.entries(normalized)) {
        if (value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    } else {
      init.body = JSON.stringify(normalized);
    }

    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new LaborProviderError(spec.provider, `request failed: ${error.message}`, { cause: error });
    }
    if (!response.ok) {
      throw new LaborProviderError(spec.provider, `request returned HTTP ${response.status}`, {
        status: response.status,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LaborProviderError(spec.provider, 'response was not valid JSON', { cause: error });
    }
    const results = responseItems(payload)
      .slice(0, MAX_RESULTS)
      .map((item) => normalizeResult(item, spec.provider))
      .filter(Boolean);
    if (results.length) return results;
  }

  return [unverifiedLaborEstimate()];
}

export const searchLabor = searchLicensedLabor;
