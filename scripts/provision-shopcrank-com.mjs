#!/usr/bin/env node
/**
 * Idempotent Cloudflare REST provisioner for www.shopcrank.com.
 *
 * Attaches the shopcrank.com zone to the Pages/Workers account, points Pages
 * shopcrank-dispatch at www.shopcrank.com, binds Worker shopcrank-api to
 * /api/* and /downloads/* (R2 installers), enables Email Sending, creates R2
 * shopcrank-files if missing, and copies GitHub-available secrets onto shopcrank-api.
 *
 * Google OAuth redirect URIs cannot be registered with a Cloudflare token.
 */
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

import {
  APEX_HOST,
  CANONICAL_HOST,
  CANONICAL_ORIGIN,
  DEFAULT_AUTH_EMAIL_FROM,
  LEGACY_APEX_HOST,
  LEGACY_HOST,
  LEGACY_HOSTS,
} from '../worker/src/production-host.mjs';

export const PAGES_PROJECT = 'shopcrank-dispatch';
export const WORKER_NAME = 'shopcrank-api';
export const LEGACY_WORKER_NAME = 'mechpro-api';
export const R2_BUCKETS = Object.freeze(['shopcrank-files', 'shopcrank-files-preview']);
export const LEGACY_R2_BUCKETS = Object.freeze(['mechpro-files', 'mechpro-files-preview']);
export const AUTH_FROM = DEFAULT_AUTH_EMAIL_FROM;
export const GOOGLE_JS_ORIGIN = CANONICAL_ORIGIN;
export const GOOGLE_REDIRECT_URI = `${CANONICAL_ORIGIN}/api/auth/google/callback`;
export const SUPPORT_EMAIL = 'support@shopcrank.com';
/** The legacy zone still serves the old host; it is retired by this script. */
export const LEGACY_ZONE = LEGACY_APEX_HOST;

export const COPYABLE_SECRET_ENV = Object.freeze({
  GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_ID',
  GOOGLE_CLIENT_SECRET: 'GOOGLE_CLIENT_SECRET',
  DIAGNOSTICS_SIGNING_PRIVATE_KEY: 'DIAGNOSTICS_SIGNING_PRIVATE_KEY',
  INTEGRATION_ENCRYPTION_KEY: 'INTEGRATION_ENCRYPTION_KEY',
  ACCESS_TEAM_DOMAIN: 'ACCESS_TEAM_DOMAIN',
  ACCESS_AUD: 'ACCESS_AUD',
  ACCESS_ADMIN_EMAILS: 'ACCESS_ADMIN_EMAILS',
  AUTH_EMAIL_WEBHOOK: 'AUTH_EMAIL_WEBHOOK',
  AUTH_EMAIL_WEBHOOK_SECRET: 'AUTH_EMAIL_WEBHOOK_SECRET',
  STRIPE_BILLING_WEBHOOK_SECRET: 'STRIPE_BILLING_WEBHOOK_SECRET',
  AUTOAUTH_UNLOCK_URL: 'AUTOAUTH_UNLOCK_URL',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  LABOR_WEB_SEARCH_API_KEY: 'LABOR_WEB_SEARCH_API_KEY',
  QUICKBOOKS_CLIENT_ID: 'QUICKBOOKS_CLIENT_ID',
  QUICKBOOKS_CLIENT_SECRET: 'QUICKBOOKS_CLIENT_SECRET',
});

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiError extends Error {
  constructor(message, { status = 0, path = '', errors = [] } = {}) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.path = path;
    this.errors = errors;
  }
}

export class ProvisionError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv = []) {
  const options = { help: false, json: false, reportPath: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--report') {
      options.reportPath = String(argv[i + 1] || '');
      i += 1;
      continue;
    }
    throw new ProvisionError(`Unknown option: ${arg}`, { exitCode: 1 });
  }
  return options;
}

export function desiredState() {
  return {
    zone: APEX_HOST,
    pagesProject: PAGES_PROJECT,
    pagesDomains: [CANONICAL_HOST, APEX_HOST],
    worker: WORKER_NAME,
    legacyWorker: LEGACY_WORKER_NAME,
    workerRoutes: desiredWorkerRoutes(),
    legacyZone: LEGACY_ZONE,
    legacyWorkerRoutes: desiredLegacyWorkerRoutes(),
    r2Buckets: [...R2_BUCKETS],
    legacyR2Buckets: [...LEGACY_R2_BUCKETS],
    emailFrom: AUTH_FROM,
    supportEmail: SUPPORT_EMAIL,
    google: {
      javascriptOrigin: GOOGLE_JS_ORIGIN,
      redirectUri: GOOGLE_REDIRECT_URI,
    },
  };
}

export function desiredWorkerRoutes() {
  return [
    `${CANONICAL_HOST}/api/*`,
    `${APEX_HOST}/api/*`,
    // Large installers live in R2; Pages cannot host the .exe/.zip artifacts.
    `${CANONICAL_HOST}/downloads/*`,
    `${APEX_HOST}/downloads/*`,
  ];
}

export function shopcrankHosts() {
  return [CANONICAL_HOST, APEX_HOST];
}

/**
 * Routes the legacy zone should end up with. The whole old host points at the
 * Worker, which answers every legacy URL with a 301 to the canonical host —
 * sign-in links, bookmarked pages, and old installer links all land on the
 * right place. The old wildcard Pages route is dropped, because a Pages
 * route would serve the site on the old host instead of redirecting.
 */
export function desiredLegacyWorkerRoutes() {
  return [
    `${LEGACY_HOST}/*`,
    `${LEGACY_APEX_HOST}/*`,
  ];
}

export function isLegacyApiRoute(pattern) {
  const { host, path } = parseRoutePattern(pattern);
  return LEGACY_HOSTS.includes(host) && path === '/api/*';
}

export function isLegacyWildcardRoute(pattern) {
  const { host, path } = parseRoutePattern(pattern);
  const bare = host.replace(/^\*\./, '');
  return host.startsWith('*.') && LEGACY_HOSTS.includes(bare)
    && (path === '' || path === '/*' || path === '/');
}

/** True for the whole-host route the Worker answers redirects on. */
export function isLegacyHostRoute(pattern) {
  const { host, path } = parseRoutePattern(pattern);
  return LEGACY_HOSTS.includes(host) && (path === '' || path === '/*' || path === '/');
}

/**
 * The old host's wildcard Pages route has to go, and /api/* has to be
 * replaced by a whole-host route so the Worker can redirect every path.
 */
export function shouldDeleteLegacyRoute(route) {
  if (isLegacyWildcardRoute(route?.pattern)) return true;
  if (isLegacyHostRoute(route?.pattern)) return route?.script !== WORKER_NAME;
  if (isLegacyApiRoute(route?.pattern)) return true;
  return false;
}

export function legacyRoutesToCreate(existing = []) {
  const have = new Set(
    existing
      .filter((route) => isLegacyHostRoute(route.pattern) && route.script === WORKER_NAME)
      .map((route) => normalizeRoutePattern(route.pattern)),
  );
  return desiredLegacyWorkerRoutes().filter((pattern) => !have.has(normalizeRoutePattern(pattern)));
}

function normalizeRoutePattern(pattern) {
  return String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '');
}

export function parseRoutePattern(pattern) {
  const normalized = normalizeRoutePattern(pattern);
  const slash = normalized.indexOf('/');
  if (slash === -1) {
    return { host: normalized, path: '' };
  }
  return {
    host: normalized.slice(0, slash),
    path: normalized.slice(slash),
  };
}

export function isDesiredApiRoute(pattern) {
  const { host, path } = parseRoutePattern(pattern);
  return shopcrankHosts().includes(host) && (path === '/api/*' || path === '/downloads/*');
}

export function isWholeHostnameRoute(pattern) {
  const { host, path } = parseRoutePattern(pattern);
  if (host === `*${APEX_HOST}` && (path === '' || path === '/*' || path === '/')) {
    return true;
  }
  if (!shopcrankHosts().includes(host)) return false;
  return path === '' || path === '/' || path === '/*';
}

export function shouldDeleteWorkerRoute(route, { worker = WORKER_NAME, legacyWorker = LEGACY_WORKER_NAME } = {}) {
  const pattern = route?.pattern;
  const script = String(route?.script || '');
  if (isWholeHostnameRoute(pattern)) return true;
  if (!shopcrankHosts().includes(parseRoutePattern(pattern).host)) return false;
  if (isDesiredApiRoute(pattern)) return false;
  return script === worker || script === legacyWorker;
}

export function routesToCreate(existing = [], desired = desiredWorkerRoutes()) {
  const have = new Set(
    existing
      .filter((route) => isDesiredApiRoute(route.pattern) && route.script === WORKER_NAME)
      .map((route) => normalizeRoutePattern(route.pattern)),
  );
  return desired.filter((pattern) => !have.has(normalizeRoutePattern(pattern)));
}

/** @deprecated alias — desired routes now include /downloads/* as well as /api/*. */
export const isDesiredWorkerRoute = isDesiredApiRoute;

export function isAlreadyConfiguredError(status, errors = []) {
  if (status === 409) return true;
  const text = (Array.isArray(errors) ? errors : [])
    .map((error) => `${error?.code || ''} ${error?.message || ''}`)
    .join(' ')
    .toLowerCase();
  return /already exists|already been|duplicate|already associated|already attached|already enabled|already configured/.test(text);
}

function sortedNames(values = []) {
  return [...values].toSorted((left, right) => String(left).localeCompare(String(right)));
}

export function secretNames(bindings = []) {
  return sortedNames(
    (Array.isArray(bindings) ? bindings : [])
      .map((binding) => binding?.name)
      .filter(Boolean),
  );
}

export function secretCopyPlan({
  sourceNames = [],
  destNames = [],
  env = {},
  envMap = COPYABLE_SECRET_ENV,
} = {}) {
  const dest = new Set(destNames);
  const source = new Set(sourceNames);
  const put = [];
  const missingValues = [];
  const alreadyOnDest = [];

  for (const [secretName, envName] of Object.entries(envMap)) {
    const value = typeof env[envName] === 'string' ? env[envName].trim() : '';
    if (!value) {
      if (source.has(secretName) && !dest.has(secretName)) {
        missingValues.push(secretName);
      }
      continue;
    }
    if (dest.has(secretName)) {
      alreadyOnDest.push(secretName);
    }
    put.push(secretName);
  }

  for (const name of sourceNames) {
    if (dest.has(name) || put.includes(name) || missingValues.includes(name)) continue;
    if (!envMap[name]) missingValues.push(name);
  }

  return {
    put: sortedNames(new Set(put)),
    missingValues: sortedNames(new Set(missingValues)),
    alreadyOnDest: sortedNames(alreadyOnDest),
    copiedFromEnv: sortedNames(put.filter((name) => source.has(name) && !dest.has(name))),
  };
}

export function googleOAuthRemaining() {
  return {
    kind: 'google_oauth',
    message: 'Register these URLs on the Google Cloud OAuth 2.0 Web client. A Cloudflare token cannot update Google Cloud.',
    javascriptOrigin: GOOGLE_JS_ORIGIN,
    redirectUri: GOOGLE_REDIRECT_URI,
  };
}

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export function createCloudflareClient({
  apiToken,
  fetchImpl = globalThis.fetch,
  baseUrl = CF_API,
} = {}) {
  if (!apiToken) {
    throw new ProvisionError('Set CLOUDFLARE_API_TOKEN (or YOUR_API_TOKEN).', { exitCode: 2 });
  }

  async function request(method, path, { query, body } = {}) {
    const url = `${baseUrl}${path}${queryString(query)}`;
    const headers = {
      Authorization: `Bearer ${apiToken}`,
    };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetchImpl(url, { method, headers, body: payload });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { success: false, errors: [{ message: text }] };
      }
    }
    if (!response.ok || json?.success === false) {
      const errors = json?.errors || [];
      if (isAlreadyConfiguredError(response.status, errors)) {
        return { ...json, success: true, alreadyConfigured: true, result: json?.result ?? null };
      }
      const message = errors.map((error) => error.message).filter(Boolean).join('; ')
        || `Cloudflare API ${response.status} ${method} ${path}`;
      throw new CloudflareApiError(message, { status: response.status, path, errors });
    }
    return json || { success: true, result: null };
  }

  return { request };
}

async function cfTry(step, fn) {
  try {
    const result = await fn();
    return { ok: true, step, ...result };
  } catch (error) {
    return {
      ok: false,
      step,
      error: error.message,
      status: error.status,
      path: error.path,
    };
  }
}

function asList(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.buckets)) return result.buckets;
  return [];
}

async function listPaged(client, path, { query = {}, resultKey } = {}) {
  const items = [];
  let page = 1;
  for (;;) {
    const payload = await client.request('GET', path, { query: { per_page: 50, page, ...query } });
    const batch = resultKey ? payload.result?.[resultKey] : payload.result;
    const list = asList(batch);
    items.push(...list);
    const info = payload.result_info;
    if (!info || page >= (info.total_pages || 1) || list.length === 0) break;
    page += 1;
  }
  return items;
}

/**
 * Finds the legacy zone on this account. It is optional: a fresh account may
 * never have had the old host, in which case the cutover steps are skipped.
 */
export async function findLegacyZone(client, { accountId, zoneName = LEGACY_ZONE }) {
  const existing = await listPaged(client, '/zones', { query: { name: zoneName, 'account.id': accountId } });
  const zone = existing.find((item) => item.name === zoneName);
  if (!zone) return { action: 'skipped', reason: `zone ${zoneName} is not on this account` };
  return { action: 'exists', zoneId: zone.id, name: zone.name, status: zone.status };
}

export async function ensureZone(client, { accountId, zoneName = APEX_HOST }) {
  const existing = await listPaged(client, '/zones', { query: { name: zoneName, 'account.id': accountId } });
  const onAccount = existing.find((zone) => zone.name === zoneName);
  if (onAccount) {
    return {
      action: 'exists',
      zoneId: onAccount.id,
      status: onAccount.status,
      nameServers: onAccount.name_servers || [],
      accountId: onAccount.account?.id || accountId,
    };
  }

  const anyNamed = await listPaged(client, '/zones', { query: { name: zoneName } });
  const elsewhere = anyNamed.find((zone) => zone.name === zoneName);
  if (elsewhere && elsewhere.account?.id && elsewhere.account.id !== accountId) {
    throw new CloudflareApiError(
      `${zoneName} is on Cloudflare account ${elsewhere.account.id}, not ${accountId}. Move the zone in the dashboard onto the Pages/Workers account.`,
      { status: 409, path: '/zones' },
    );
  }

  const created = await client.request('POST', '/zones', {
    body: { name: zoneName, type: 'full', account: { id: accountId } },
  });
  const zone = created.result || {};
  return {
    action: created.alreadyConfigured ? 'exists' : 'created',
    zoneId: zone.id,
    status: zone.status,
    nameServers: zone.name_servers || [],
    accountId: zone.account?.id || accountId,
  };
}

export async function ensurePagesDomains(client, { accountId, project = PAGES_PROJECT, domains = desiredState().pagesDomains }) {
  const path = `/accounts/${accountId}/pages/projects/${project}/domains`;
  let current = [];
  try {
    current = asList((await client.request('GET', path)).result);
  } catch (error) {
    if (error.status === 404) {
      throw new CloudflareApiError(
        `Pages project ${project} was not found on account ${accountId}.`,
        { status: 404, path },
      );
    }
    throw error;
  }
  const have = new Set(current.map((domain) => domain.name || domain));
  const added = [];
  for (const name of domains) {
    if (have.has(name)) continue;
    const payload = await client.request('POST', path, { body: { name } });
    added.push({ name, alreadyConfigured: Boolean(payload.alreadyConfigured) });
    have.add(name);
  }
  const refreshed = asList((await client.request('GET', path)).result);
  return {
    action: added.length ? 'updated' : 'exists',
    domains: refreshed.map((domain) => ({
      name: domain.name,
      status: domain.status,
    })),
    added: added.map((item) => item.name),
  };
}

/**
 * Restores the DNS records for a host.
 *
 * Detaching a Worker custom domain removes the hostname's DNS record, so a
 * host that was bound that way stops resolving. The Worker route alone is
 * not enough: without a record, the redirect is unreachable. This recreates a
 * proxied record so the Worker answers on that hostname.
 */
export async function ensureDnsRecords(client, { zoneId, records = [] }) {
  const path = `/zones/${zoneId}/dns_records`;
  const existing = asList((await client.request('GET', path)).result);
  const created = [];
  const updated = [];
  for (const record of records) {
    const match = existing.find((item) => item.type === record.type && item.name === record.name);
    if (match) {
      if (match.content === record.content && match.proxied === record.proxied) continue;
      await client.request('PUT', `${path}/${match.id}`, { body: { ...record, ttl: 1 } });
      updated.push({ type: record.type, name: record.name, content: record.content });
      continue;
    }
    await client.request('POST', path, { body: { ...record, ttl: 1 } });
    created.push({ type: record.type, name: record.name, content: record.content });
  }
  return {
    action: created.length || updated.length ? 'updated' : 'exists',
    created,
    updated,
  };
}

/**
 * The legacy host's records. The zone is proxied on Cloudflare's anycast
 * addresses, so a proxied A record to the zone's own address is enough for
 * the Worker route to answer.
 */
export function legacyDnsRecords() {
  return [
    { type: 'A', name: LEGACY_APEX_HOST, content: '104.21.17.176', proxied: true },
    { type: 'A', name: LEGACY_HOST, content: '104.21.17.188', proxied: true },
  ];
}

export async function detachWholeHostWorkerDomains(client, { accountId, hosts = shopcrankHosts() }) {
  const records = asList((await client.request('GET', `/accounts/${accountId}/workers/domains`)).result);
  const detached = [];
  for (const domain of records) {
    if (!hosts.includes(domain.hostname)) continue;
    await client.request('DELETE', `/accounts/${accountId}/workers/domains/${domain.id}`);
    detached.push({ hostname: domain.hostname, service: domain.service, id: domain.id });
  }
  return { action: detached.length ? 'detached' : 'none', detached };
}

/**
 * The legacy host is still bound as a whole-hostname Worker custom domain on
 * the old Worker. That binding outranks the zone routes, so it has to be
 * detached before the host can be retired; the zone /api/* route then serves
 * the Worker's legacy->canonical redirect.
 */
export async function detachLegacyWorkerDomains(client, { accountId, hosts = LEGACY_HOSTS }) {
  const records = asList((await client.request('GET', `/accounts/${accountId}/workers/domains`)).result);
  const detached = [];
  for (const domain of records) {
    if (!hosts.includes(domain.hostname)) continue;
    await client.request('DELETE', `/accounts/${accountId}/workers/domains/${domain.id}`);
    detached.push({ hostname: domain.hostname, service: domain.service, id: domain.id });
  }
  return { action: detached.length ? 'detached' : 'none', detached };
}

/**
 * Retires the legacy zone: drop the wildcard Pages route so the old host
 * stops serving the marketing site, and keep /api/* on the current Worker so
 * the legacy->canonical redirect can answer API calls on the old host.
 */
export async function ensureLegacyWorkerRoutes(client, { zoneId, worker = WORKER_NAME }) {
  const path = `/zones/${zoneId}/workers/routes`;
  const existing = asList((await client.request('GET', path)).result);
  const deleted = [];
  for (const route of existing) {
    if (!shouldDeleteLegacyRoute(route)) continue;
    await client.request('DELETE', `${path}/${route.id}`);
    deleted.push({ pattern: route.pattern, script: route.script });
  }
  const remaining = existing.filter((route) => !deleted.some((item) => item.pattern === route.pattern && item.script === route.script));
  const created = [];
  for (const pattern of legacyRoutesToCreate(remaining)) {
    const payload = await client.request('POST', path, { body: { pattern, script: worker } });
    created.push({ pattern, alreadyConfigured: Boolean(payload.alreadyConfigured) });
  }
  const finalRoutes = asList((await client.request('GET', path)).result)
    .filter((route) => isLegacyHostRoute(route.pattern) || isLegacyApiRoute(route.pattern) || isLegacyWildcardRoute(route.pattern));
  return {
    action: created.length || deleted.length ? 'updated' : 'exists',
    routes: finalRoutes.map((route) => ({ pattern: route.pattern, script: route.script })),
    created: created.map((item) => item.pattern),
    deleted,
  };
}

/**
 * Points the support address at a real destination. The legacy zone routed
 * mail to the old owner's Gmail address; the ShopCrank zone needs the same
 * forwarding so support@shopcrank.com reaches a human.
 */
export async function ensureSupportForwarding(client, { zoneId, address = SUPPORT_EMAIL, forwardTo }) {
  if (!forwardTo) {
    return { action: 'skipped', reason: 'no support forward target configured', address };
  }
  const path = `/zones/${zoneId}/email/routing/rules`;
  const existing = asList((await client.request('GET', path)).result);
  const matcher = { type: 'literal', field: 'to', value: address };
  const already = existing.find((rule) => (rule.matchers || []).some((m) => m.type === 'literal' && m.field === 'to' && m.value === address));
  if (already) {
    const forwarded = (already.actions || []).some((action) => action.type === 'forward' && (action.value || []).includes(forwardTo));
    if (forwarded && already.enabled) {
      return { action: 'exists', address, forwardTo, ruleId: already.id };
    }
    const updated = await client.request('PUT', `${path}/${already.id}`, {
      body: {
        name: '',
        matchers: [matcher],
        actions: [{ type: 'forward', value: [forwardTo] }],
        enabled: true,
        priority: 0,
      },
    });
    return { action: 'updated', address, forwardTo, ruleId: already.id, result: updated?.result ?? null };
  }
  const created = await client.request('POST', path, {
    body: {
      name: '',
      matchers: [matcher],
      actions: [{ type: 'forward', value: [forwardTo] }],
      enabled: true,
      priority: 0,
    },
  });
  return { action: 'created', address, forwardTo, ruleId: created?.result?.id ?? null };
}

export async function ensureWorkerRoutes(client, { zoneId, worker = WORKER_NAME }) {
  const path = `/zones/${zoneId}/workers/routes`;
  const existing = asList((await client.request('GET', path)).result);
  const deleted = [];
  for (const route of existing) {
    if (!shouldDeleteWorkerRoute(route, { worker })) continue;
    await client.request('DELETE', `${path}/${route.id}`);
    deleted.push({ pattern: route.pattern, script: route.script });
  }
  const remaining = existing.filter((route) => !deleted.some((item) => item.pattern === route.pattern && item.script === route.script));
  const created = [];
  for (const pattern of routesToCreate(remaining)) {
    const payload = await client.request('POST', path, { body: { pattern, script: worker } });
    created.push({ pattern, alreadyConfigured: Boolean(payload.alreadyConfigured) });
  }
  const finalRoutes = asList((await client.request('GET', path)).result)
    .filter((route) => isDesiredApiRoute(route.pattern) || shopcrankHosts().includes(parseRoutePattern(route.pattern).host));
  return {
    action: created.length || deleted.length ? 'updated' : 'exists',
    routes: finalRoutes.map((route) => ({ pattern: route.pattern, script: route.script })),
    created: created.map((item) => item.pattern),
    deleted,
  };
}

export async function ensureR2Buckets(client, { accountId, buckets = R2_BUCKETS }) {
  const listed = asList((await client.request('GET', `/accounts/${accountId}/r2/buckets`)).result);
  const have = new Set(listed.map((bucket) => bucket.name));
  const created = [];
  const legacyPresent = LEGACY_R2_BUCKETS.filter((name) => have.has(name));
  for (const name of buckets) {
    if (have.has(name)) continue;
    await client.request('POST', `/accounts/${accountId}/r2/buckets`, { body: { name } });
    created.push(name);
    have.add(name);
  }
  return {
    action: created.length ? 'created' : 'exists',
    buckets: buckets.filter((name) => have.has(name)),
    created,
    legacyPresent,
  };
}

export async function enableEmail(client, { accountId, zoneId, from = AUTH_FROM }) {
  const routing = await cfTry('email-routing', async () => {
    let settings;
    try {
      settings = (await client.request('GET', `/zones/${zoneId}/email/routing`)).result;
    } catch {
      settings = null;
    }
    if (settings?.enabled || settings?.status === 'ready') {
      return { enabled: true, status: settings.status || 'ready' };
    }
    const enabled = (await client.request('POST', `/zones/${zoneId}/email/routing/enable`)).result;
    return { enabled: true, status: enabled?.status || 'enabled' };
  });

  const sending = await cfTry('email-sending', async () => {
    const listed = asList((await client.request('GET', `/zones/${zoneId}/email/sending/subdomains`)).result);
    const apex = listed.find((item) => item.name === APEX_HOST);
    if (apex?.enabled) {
      return { enabled: true, name: apex.name, tag: apex.tag, status: 'enabled' };
    }
    const created = (await client.request('POST', `/zones/${zoneId}/email/sending/subdomains`, {
      body: { name: APEX_HOST },
    })).result;
    return {
      enabled: Boolean(created?.enabled ?? true),
      name: created?.name || APEX_HOST,
      tag: created?.tag,
      status: created?.enabled === false ? 'disabled' : 'enabled',
    };
  });

  const destination = await cfTry('email-from', async () => {
    const listed = asList((await client.request('GET', `/accounts/${accountId}/email/routing/addresses`)).result);
    let address = listed.find((item) => item.email === from);
    let created = false;
    if (!address) {
      address = (await client.request('POST', `/accounts/${accountId}/email/routing/addresses`, {
        body: { email: from },
      })).result || { email: from };
      created = true;
    }
    if (address?.id && !address.verified) {
      try {
        const patched = (await client.request('PATCH', `/accounts/${accountId}/email/routing/addresses/${address.id}`, {
          body: { status: 'verified' },
        })).result;
        address = { ...address, ...patched, verified: patched?.verified || patched?.status === 'verified' || address.verified };
      } catch {
        // Non-admin tokens cannot mark a destination verified; Email Sending
        // still allows sending from noreply@ once the zone is enabled.
      }
    }
    return {
      email: from,
      verified: Boolean(address?.verified),
      verifiedAt: address?.verified || null,
      created,
      id: address?.id,
    };
  });

  if (!sending.ok && !routing.ok) {
    throw new CloudflareApiError(
      sending.error || routing.error || 'Failed to enable Email Sending and Email Routing',
      { status: sending.status || routing.status || 500, path: '/email' },
    );
  }

  return {
    action: sending.ok && sending.enabled ? 'enabled' : (routing.ok ? 'routing' : 'partial'),
    routing,
    sending,
    destination,
    from,
  };
}

export async function syncWorkerSecrets(client, {
  accountId,
  worker = WORKER_NAME,
  legacyWorker = LEGACY_WORKER_NAME,
  env = process.env,
}) {
  async function listSecrets(script) {
    try {
      return secretNames((await client.request('GET', `/accounts/${accountId}/workers/scripts/${script}/secrets`)).result);
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  const sourceNames = await listSecrets(legacyWorker);
  const destNames = await listSecrets(worker);
  const plan = secretCopyPlan({ sourceNames, destNames, env });
  const put = [];
  for (const name of plan.put) {
    const envName = COPYABLE_SECRET_ENV[name];
    const text = String(env[envName] || '').trim();
    if (!text) continue;
    await client.request('PUT', `/accounts/${accountId}/workers/scripts/${worker}/secrets`, {
      body: { name, text, type: 'secret_text' },
    });
    put.push(name);
  }
  return {
    action: put.length ? 'updated' : 'exists',
    legacyWorkerPresent: sourceNames.length > 0,
    sourceNames,
    destNames,
    put,
    missingValues: plan.missingValues,
  };
}

export async function provisionShopcrankCom({
  client,
  accountId,
  env = process.env,
  logger = console,
} = {}) {
  if (!accountId) {
    throw new ProvisionError('Set CLOUDFLARE_ACCOUNT_ID.', { exitCode: 2 });
  }

  const report = {
    ok: true,
    accountId,
    desired: desiredState(),
    steps: {},
    remaining: [googleOAuthRemaining()],
  };

  const zoneStep = await cfTry('zone', () => ensureZone(client, { accountId }));
  report.steps.zone = zoneStep;
  if (!zoneStep.ok) {
    report.ok = false;
    return report;
  }
  if (zoneStep.status && zoneStep.status !== 'active' && zoneStep.nameServers?.length) {
    report.remaining.push({
      kind: 'nameservers',
      message: `Point the ${APEX_HOST} registrar at these Cloudflare nameservers, then wait for the zone to become active.`,
      nameServers: zoneStep.nameServers,
      status: zoneStep.status,
    });
  }

  const zoneId = zoneStep.zoneId;
  const supportForward = String(env.SUPPORT_EMAIL_FORWARD_TO || '').trim();
  const steps = {
    pages: () => ensurePagesDomains(client, { accountId }),
    workerDomains: () => detachWholeHostWorkerDomains(client, { accountId }),
    workerRoutes: () => ensureWorkerRoutes(client, { zoneId }),
    legacyWorkerDomains: () => detachLegacyWorkerDomains(client, { accountId }),
    legacyZone: () => findLegacyZone(client, { accountId }),
    r2: () => ensureR2Buckets(client, { accountId }),
    email: () => enableEmail(client, { accountId, zoneId }),
    supportMail: () => ensureSupportForwarding(client, { zoneId, forwardTo: supportForward }),
    secrets: () => syncWorkerSecrets(client, { accountId, env }),
  };

  for (const [name, fn] of Object.entries(steps)) {
    const result = await cfTry(name, fn);
    report.steps[name] = result;
    if (!result.ok) report.ok = false;
    logger.info?.(`[provision] ${name}: ${result.ok ? result.action || 'ok' : result.error}`);
  }

  // The legacy zone is only touched after the shared steps ran, so a failure
  // above never leaves the old host half-rewired.
  if (report.steps.legacyZone?.ok && report.steps.legacyZone.zoneId) {
    const legacyZoneId = report.steps.legacyZone.zoneId;
    const legacyRoutes = await cfTry('legacyWorkerRoutes', () => ensureLegacyWorkerRoutes(client, {
      zoneId: legacyZoneId,
    }));
    report.steps.legacyWorkerRoutes = legacyRoutes;
    if (!legacyRoutes.ok) report.ok = false;
    logger.info?.(`[provision] legacyWorkerRoutes: ${legacyRoutes.ok ? legacyRoutes.action || 'ok' : legacyRoutes.error}`);

    // Detaching the old custom domain removed the legacy DNS records, so the
    // redirect would be unreachable. Put them back.
    const legacyDns = await cfTry('legacyDns', () => ensureDnsRecords(client, {
      zoneId: legacyZoneId,
      records: legacyDnsRecords(),
    }));
    report.steps.legacyDns = legacyDns;
    if (!legacyDns.ok) report.ok = false;
    logger.info?.(`[provision] legacyDns: ${legacyDns.ok ? legacyDns.action || 'ok' : legacyDns.error}`);
  } else if (report.steps.legacyZone && !report.steps.legacyZone.ok) {
    report.ok = false;
  } else {
    report.steps.legacyWorkerRoutes = { ok: true, action: 'skipped', reason: `legacy zone ${LEGACY_ZONE} not on this account` };
  }

  if (report.steps.email?.destination && !report.steps.email.destination.verified) {
    report.remaining.push({
      kind: 'email_from',
      message: `Email Sending is enabled for ${APEX_HOST}, so the Worker can send as ${AUTH_FROM}. Cloudflare still needs the destination-address verification mail for ${AUTH_FROM} to show as verified in Email Routing.`,
    });
  }

  if (report.steps.secrets?.missingValues?.length) {
    report.remaining.push({
      kind: 'worker_secrets',
      message: `These secrets exist on ${LEGACY_WORKER_NAME} (names only) and are not in this environment, so they cannot be copied onto ${WORKER_NAME}. Put them with wrangler secret put.`,
      names: report.steps.secrets.missingValues,
    });
  }

  if (report.steps.supportMail?.action === 'skipped') {
    report.remaining.push({
      kind: 'support_email',
      message: `Set SUPPORT_EMAIL_FORWARD_TO to the mailbox that should receive ${SUPPORT_EMAIL}, then re-run this script. Until then, support tickets are stored in D1 but no email is sent.`,
    });
  }

  return report;
}

export function formatReport(report) {
  const lines = [
    `ShopCrank Cloudflare provision: ${report.ok ? 'ok' : 'failed'}`,
    `Account: ${report.accountId}`,
    `Pages ${PAGES_PROJECT} → ${CANONICAL_HOST}`,
    `Worker ${WORKER_NAME} routes: ${desiredWorkerRoutes().join(', ')}`,
    '',
  ];
  for (const [name, step] of Object.entries(report.steps || {})) {
    if (step.ok) {
      lines.push(`- ${name}: ${step.action || 'ok'}${step.error ? ` (${step.error})` : ''}`);
    } else {
      lines.push(`- ${name}: FAILED ${step.error || ''}`.trim());
    }
  }
  if (report.steps?.zone?.nameServers?.length) {
    lines.push('', `Nameservers: ${report.steps.zone.nameServers.join(', ')}`);
  }
  if (report.remaining?.length) {
    lines.push('', 'Remaining outside Cloudflare:');
    for (const item of report.remaining) {
      lines.push(`- ${item.kind}: ${item.message}`);
      if (item.javascriptOrigin) lines.push(`  origin ${item.javascriptOrigin}`);
      if (item.redirectUri) lines.push(`  redirect ${item.redirectUri}`);
      if (item.names) lines.push(`  ${item.names.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export const HELP_TEXT = `Provision shopcrank.com on the Cloudflare Pages/Workers account

Usage:
  node scripts/provision-shopcrank-com.mjs [--json] [--report <path>]
  npm run provision:shopcrank-com -- [--json]

Requires:
  CLOUDFLARE_API_TOKEN (or YOUR_API_TOKEN)
  CLOUDFLARE_ACCOUNT_ID
  SUPPORT_EMAIL_FORWARD_TO (optional) — mailbox that receives ${SUPPORT_EMAIL}

Attaches Pages ${PAGES_PROJECT} as ${CANONICAL_HOST}, Worker ${WORKER_NAME} as
${desiredWorkerRoutes().join(' and ')} only, enables Email Sending for
${APEX_HOST}, and copies GitHub-available secrets onto ${WORKER_NAME}.

It also finishes the cutover away from the legacy host: the old
${LEGACY_ZONE} custom domains are detached from ${LEGACY_WORKER_NAME} and its
wildcard Pages route is dropped, so ${LEGACY_HOST} and ${LEGACY_APEX_HOST}
stop serving the site and only redirect to ${CANONICAL_HOST}.
`;

export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl, logger = console } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    logger.log(HELP_TEXT);
    return { exitCode: 0 };
  }
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || env.YOUR_API_TOKEN || '').trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '').trim();
  const client = createCloudflareClient({ apiToken, fetchImpl });
  const report = await provisionShopcrankCom({ client, accountId, env, logger });
  const text = formatReport(report);
  if (options.json) logger.log(JSON.stringify(report, null, 2));
  else logger.log(text);
  if (options.reportPath) {
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    writeFileSync(env.GITHUB_STEP_SUMMARY, `## shopcrank.com provision\n\n\`\`\`\n${text}\`\`\`\n`, { flag: 'a' });
  }
  return { exitCode: report.ok ? 0 : 1, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { exitCode } = await main();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = error.exitCode || 1;
  }
}
