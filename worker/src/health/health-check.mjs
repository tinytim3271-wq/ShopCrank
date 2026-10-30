// Dependency health check for the assistant tools and the integrations behind them.
//
// Pings D1, the inventory service (D1 inventory records + each shop's PartsTech
// connection), QuickBooks Online, Stripe webhooks and the YouTube Data API, runs read-only canary calls
// of the assistant tools against tool-contracts.mjs, and writes one JSON line per
// (tool, dependency) result. Runs on HEALTH_CHECK_CRON and on demand from the
// platform console (POST /api/admin/health-check).
//
// Dry run: no third-party calls, no token refresh, no R2/D1 writes, no email.
// Config is still validated, and D1 is still read (SELECT only).

import { HttpError, json, requestJson } from '../http.mjs';
import { CANONICAL_ORIGIN, DEFAULT_AUTH_EMAIL_FROM } from '../production-host.mjs';
import { serializeError } from '../redact.mjs';
import { accessToken as partstechAccessToken } from '../integrations/partstech.mjs';
import { pingQuickbooks, quickbooksConfigStatus } from '../integrations/quickbooks.mjs';
import { pingYouTube, youtubeConfigured } from '../integrations/youtube.mjs';
import { PARTSTECH_API_BASE, PARTSTECH_SECRET_NAME, partstechConnectionStatus } from '../../../src/modules/partstech.js';
import { QUICKBOOKS_SECRET_NAME } from '../../../src/modules/quickbooks.js';
import { checkToolOutput } from './schema.mjs';
import { TOOL_CONTRACTS, TOOL_CONTRACTS_CHANGELOG, TOOL_CONTRACTS_VERSION, toolsUsingDependency } from './tool-contracts.mjs';

// Every 6 hours at :30, apart from the follow-up (15:00) and export (08:00) crons.
// Hours are listed because the repo's JSONC readers treat a step's "*/" as a comment end.
export const HEALTH_CHECK_CRON = '30 0,6,12,18 * * *';
export const HEALTH_LOG_PREFIX = 'health-checks/';
export const HEALTH_STATUSES = Object.freeze(['ok', 'degraded', 'down', 'not_configured', 'skipped']);

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_SECRET = 'stripe-secret-key';
const STRIPE_WEBHOOK_SECRET = 'stripe-webhook-secret';
const STRIPE_REQUIRED_EVENT = 'checkout.session.completed';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_SHOPS = 25;
const CONCURRENCY = 5;
const MAX_EMAIL_JSONL = 64_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RUN_NAME = /^\d{13}-[a-z0-9-]{8,64}$/;

export const DEPENDENCIES = Object.freeze({
  d1: { label: 'D1 database' },
  inventory: { label: 'Inventory service (D1 inventory records, PartsTech catalog)' },
  quickbooks: { label: 'QuickBooks Online API' },
  'stripe-webhooks': { label: 'Stripe webhooks' },
  youtube: { label: 'YouTube Data API (text assistant video tools)' },
});

function positiveInt(value, fallback, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function errorPayload(error) {
  const { stack: _stack, ...rest } = serializeError(error);
  return rest;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function timed(fn, timeoutMs) {
  const started = Date.now();
  try {
    const outcome = await withTimeout(Promise.resolve().then(fn), timeoutMs);
    return { status: 'ok', error: null, ...outcome, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 'down', error: errorPayload(error), latencyMs: Date.now() - started };
  }
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function publicOrigin(env) {
  return String(env.HEALTHCHECK_PUBLIC_ORIGIN || env.GOOGLE_REDIRECT_ORIGIN || CANONICAL_ORIGIN).replace(/\/+$/, '');
}

function knownHosts(env) {
  const hosts = new Set([new URL(publicOrigin(env)).host]);
  for (const origin of String(env.ALLOWED_ORIGINS || '').split(',')) {
    try {
      if (origin.trim()) hosts.add(new URL(origin.trim()).host);
    } catch {
      // Ignore malformed configured origins.
    }
  }
  return hosts;
}

/** Compare Stripe's webhook endpoints with the URL ShopCrank expects. */
export function evaluateStripeEndpoints(endpoints, { path, hosts }) {
  const matches = (Array.isArray(endpoints) ? endpoints : []).filter((endpoint) => {
    try {
      return new URL(endpoint.url).pathname === path;
    } catch {
      return false;
    }
  });
  if (!matches.length) {
    return { status: 'down', error: { message: `No Stripe webhook endpoint points at ${path}`, code: 'webhook_missing' } };
  }
  const onHost = matches.filter(endpoint => hosts.has(new URL(endpoint.url).host));
  const enabled = onHost.filter(endpoint => endpoint.status === 'enabled');
  if (!onHost.length) {
    return { status: 'degraded', error: { message: `Stripe webhook ${path} is registered on another host (${new URL(matches[0].url).host})`, code: 'webhook_wrong_host' } };
  }
  if (!enabled.length) {
    return { status: 'down', error: { message: `Stripe webhook ${path} is disabled in Stripe`, code: 'webhook_disabled' } };
  }
  const events = enabled.flatMap(endpoint => endpoint.enabled_events || []);
  if (!events.includes('*') && !events.includes(STRIPE_REQUIRED_EVENT)) {
    return { status: 'degraded', error: { message: `Stripe webhook ${path} does not send ${STRIPE_REQUIRED_EVENT}`, code: 'webhook_event_missing' } };
  }
  return { status: 'ok', detail: `${enabled.length} enabled endpoint(s)` };
}

async function listStripeEndpoints(secretKey, fetcher) {
  const response = await fetcher(`${STRIPE_API}/webhook_endpoints?limit=100`, {
    headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body?.error?.message || `Stripe API returned HTTP ${response.status}`), { status: response.status, code: body?.error?.code || 'stripe_error' });
  }
  return body.data || [];
}

/** Shops with at least one integration the health check pings. */
export async function shopsWithIntegrations(env, limit) {
  const names = [STRIPE_SECRET, QUICKBOOKS_SECRET_NAME, PARTSTECH_SECRET_NAME];
  const result = await env.DB.prepare(`
    SELECT shop_id, group_concat(secret_name) AS names FROM integration_secrets
    WHERE secret_name IN (?, ?, ?) GROUP BY shop_id ORDER BY shop_id LIMIT ?
  `).bind(...names, limit).all();
  return (result.results || []).map(row => ({ shopId: row.shop_id, secrets: new Set(String(row.names || '').split(',')) }));
}

function probe(dependency, name, tools, run, shopId = null) {
  return { dependency, probe: name, tools, run, shopId };
}

function buildProbes(env, { dryRun, shops, fetcher, getSecret, saveSecret }) {
  const shopGetSecret = (shopId, name) => getSecret(env, shopId, name);
  const hosts = knownHosts(env);
  const probes = [
    probe('d1', 'd1.select', toolsUsingDependency('d1'), async () => {
      if (!env.DB) return { status: 'not_configured', error: { message: 'DB binding is missing' } };
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      if (Number(row?.ok) !== 1) return { status: 'down', error: { message: 'SELECT 1 returned an unexpected result' } };
      return { status: 'ok' };
    }),
    probe('inventory', 'inventory.d1', toolsUsingDependency('inventory'), async () => {
      if (!env.DB) return { status: 'not_configured', error: { message: 'DB binding is missing' } };
      await env.DB.prepare("SELECT entity_id FROM entities WHERE entity_type = 'inventory' LIMIT 1").all();
      return { status: 'ok' };
    }),
    probe('youtube', 'youtube.api', toolsUsingDependency('youtube'), async () => {
      if (!youtubeConfigured(env)) return { status: 'not_configured', error: { message: 'YOUTUBE_API_KEY is not set' } };
      if (dryRun) return { status: 'ok', detail: 'config valid; YouTube not called (dry run)' };
      await pingYouTube(env, { fetcher });
      return { status: 'ok' };
    }),
    probe('stripe-webhooks', 'stripe.billing', ['billing.stripe_webhook'], async () => {
      const key = String(env.STRIPE_SECRET_KEY || '');
      if (!key) return { status: 'not_configured', error: { message: 'STRIPE_SECRET_KEY is not set (platform billing)' } };
      if (!env.STRIPE_BILLING_WEBHOOK_SECRET) return { status: 'down', error: { message: 'STRIPE_BILLING_WEBHOOK_SECRET is not set', code: 'webhook_secret_missing' } };
      if (!/^(sk|rk)_(test|live)_/.test(key)) return { status: 'down', error: { message: 'STRIPE_SECRET_KEY is not a Stripe secret key', code: 'bad_secret_key' } };
      if (dryRun) return { status: 'ok', detail: 'config valid; Stripe API not called (dry run)' };
      return evaluateStripeEndpoints(await listStripeEndpoints(key, fetcher), { path: '/api/billing/webhook', hosts });
    }),
  ];

  for (const { shopId, secrets } of shops) {
    if (secrets.has(PARTSTECH_SECRET_NAME)) {
      probes.push(probe('inventory', 'inventory.partstech', ['parts.partstech'], async () => {
        const raw = await shopGetSecret(shopId, PARTSTECH_SECRET_NAME);
        let credentials = null;
        try {
          credentials = JSON.parse(raw || 'null');
        } catch {
          return { status: 'down', error: { message: 'Stored PartsTech credentials are unreadable', code: 'bad_credentials' } };
        }
        if (!partstechConnectionStatus(credentials).connected) return { status: 'not_configured', error: { message: 'PartsTech not connected' } };
        if (dryRun) return { status: 'ok', detail: 'config valid; PartsTech not called (dry run)' };
        await partstechAccessToken(credentials, { fetcher, baseUrl: env.PARTSTECH_API_BASE || PARTSTECH_API_BASE });
        return { status: 'ok' };
      }, shopId));
    }
    if (secrets.has(QUICKBOOKS_SECRET_NAME)) {
      probes.push(probe('quickbooks', 'quickbooks.companyinfo', [...toolsUsingDependency('quickbooks'), 'integrations.quickbooks.sync'], async () => {
        const config = await quickbooksConfigStatus(env, { shopId, getSecret: shopGetSecret });
        if (!config.configured) return { status: 'not_configured', error: { message: config.reason } };
        if (!config.valid) return { status: 'down', error: { message: config.reason, code: 'invalid_config' } };
        if (dryRun) return { status: 'ok', detail: 'config valid; QuickBooks not called (dry run)' };
        await pingQuickbooks(env, { shopId, getSecret: shopGetSecret, saveSecret, fetcher });
        return { status: 'ok' };
      }, shopId));
    }
    if (secrets.has(STRIPE_SECRET)) {
      probes.push(probe('stripe-webhooks', 'stripe.shop_webhook', [...toolsUsingDependency('stripe-webhooks'), 'payments.stripe_webhook'], async () => {
        const [secretKey, webhookSecret] = await Promise.all([shopGetSecret(shopId, STRIPE_SECRET), shopGetSecret(shopId, STRIPE_WEBHOOK_SECRET)]);
        if (!secretKey) return { status: 'not_configured', error: { message: 'Stripe secret key not saved' } };
        if (!/^whsec_/.test(webhookSecret || '')) return { status: 'down', error: { message: 'Stripe webhook signing secret is missing or malformed', code: 'webhook_secret_missing' } };
        if (!/^(sk|rk)_(test|live)_/.test(secretKey)) return { status: 'down', error: { message: 'Saved Stripe secret key is malformed', code: 'bad_secret_key' } };
        if (dryRun) return { status: 'ok', detail: 'config valid; Stripe API not called (dry run)' };
        const path = `/api/payments/webhook/${encodeURIComponent(shopId)}`;
        return evaluateStripeEndpoints(await listStripeEndpoints(secretKey, fetcher), { path, hosts });
      }, shopId));
    }
  }
  return probes;
}

async function runCanaries(env, { dryRun, timeoutMs, executeTool }) {
  const shopId = String(env.HEALTHCHECK_CANARY_SHOP_ID || 'healthcheck-canary');
  const tasks = Object.entries(TOOL_CONTRACTS)
    .filter(([, contract]) => contract.canary)
    .map(([name, contract]) => async () => {
      const { persona, role = '', args, network, requires, channel } = contract.canary;
      if (requires && !String(env[requires] || '').trim()) {
        return { tool: name, shopId, status: 'not_configured', latencyMs: 0, error: { message: `${requires} is not set` } };
      }
      if (network && dryRun) {
        return { tool: name, shopId, status: 'skipped', latencyMs: 0, error: { message: 'calls a third party; skipped in dry run' } };
      }
      const outcome = await timed(async () => {
        const result = await executeTool(env, { shopId, persona, role, userId: 'healthcheck', name, args, channel });
        const check = checkToolOutput(name, result);
        if (check.kind === 'ok') return { status: 'ok' };
        if (check.kind === 'error') return { status: 'degraded', error: { message: String(result.error).slice(0, 300), code: 'tool_error' } };
        return { status: 'degraded', error: { message: `Output drifted from contract v${check.version}`, code: 'schema_drift', issues: check.issues } };
      }, timeoutMs);
      return { tool: name, shopId, ...outcome };
    });
  return pool(tasks, CONCURRENCY);
}

function summarize(entries) {
  const counts = Object.fromEntries(HEALTH_STATUSES.map(status => [status, 0]));
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return counts;
}

/**
 * Run every probe and canary. Returns the run summary, the probe results and
 * `entries`: one log line per (tool, dependency) with timestamp, tool,
 * dependency, status, latencyMs and error.
 */
export async function runHealthCheck(env, {
  dryRun = false,
  trigger = 'manual',
  fetcher = globalThis.fetch,
  getSecret,
  saveSecret,
  executeTool,
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const runId = crypto.randomUUID();
  const timeoutMs = positiveInt(env.HEALTHCHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 30_000);
  const shops = env.DB ? await shopsWithIntegrations(env, positiveInt(env.HEALTHCHECK_MAX_SHOPS, DEFAULT_MAX_SHOPS, 200)).catch(() => []) : [];
  const probes = buildProbes(env, { dryRun, shops, fetcher, getSecret, saveSecret });
  const probeResults = await pool(probes.map(item => async () => {
    const outcome = await timed(item.run, timeoutMs);
    return { dependency: item.dependency, probe: item.probe, shopId: item.shopId, tools: item.tools, timestamp: now().toISOString(), ...outcome };
  }), CONCURRENCY);
  const executeAssistantTool = executeTool || (await import('../assistant/tools.mjs')).executeAssistantTool;
  const canaries = await runCanaries(env, { dryRun, timeoutMs, executeTool: executeAssistantTool });

  const base = { runId, trigger, dryRun, contractVersion: TOOL_CONTRACTS_VERSION };
  const entries = [
    ...probeResults.flatMap(result => result.tools.map(tool => ({
      timestamp: result.timestamp,
      ...base,
      tool,
      dependency: result.dependency,
      probe: result.probe,
      shopId: result.shopId,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error || null,
      ...(result.detail ? { detail: result.detail } : {}),
    }))),
    ...canaries.map(result => ({
      timestamp: now().toISOString(),
      ...base,
      tool: result.tool,
      dependency: 'tool-contract',
      probe: 'canary',
      shopId: result.shopId,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error || null,
    })),
  ];
  const finishedAt = now().toISOString();
  const failing = [...probeResults, ...canaries].filter(item => item.status === 'down' || item.status === 'degraded');
  return {
    ...base,
    startedAt,
    finishedAt,
    ok: failing.length === 0,
    counts: summarize(entries),
    probes: probeResults.map(({ tools, timestamp: _timestamp, ...rest }) => ({ ...rest, tools: tools.length })),
    canaries,
    entries,
  };
}

export function toJsonl(entries) {
  return entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
}

export function healthLogKey(run) {
  const inverted = String(9_999_999_999_999 - Date.parse(run.startedAt)).padStart(13, '0');
  return `${HEALTH_LOG_PREFIX}${inverted}-${run.runId}.jsonl`;
}

function failures(run) {
  return [...run.probes, ...run.canaries.map(item => ({ ...item, dependency: 'tool-contract', probe: item.tool }))]
    .filter(item => item.status === 'down' || item.status === 'degraded');
}

/** Store the JSONL in R2 (newest-first keys) and a summary row in D1 audit_log. */
export async function persistHealthRun(env, run, actor = null) {
  if (run.dryRun) return { stored: false, reason: 'dry_run' };
  const storage = { stored: false, key: null, auditId: null, errors: [] };
  if (env.FILES?.put) {
    const key = healthLogKey(run);
    try {
      await env.FILES.put(key, toJsonl(run.entries), {
        httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' },
        customMetadata: { runId: run.runId, trigger: run.trigger, ok: String(run.ok), startedAt: run.startedAt, counts: JSON.stringify(run.counts) },
      });
      Object.assign(storage, { stored: true, key });
    } catch (error) {
      storage.errors.push({ store: 'r2', ...errorPayload(error) });
    }
  } else {
    storage.errors.push({ store: 'r2', message: 'FILES binding is missing' });
  }
  if (env.DB) {
    const id = `audit-${Date.now()}-${crypto.randomUUID()}`;
    const event = {
      kind: 'healthcheck.run',
      runId: run.runId,
      trigger: run.trigger,
      ok: run.ok,
      counts: run.counts,
      logKey: storage.key,
      failures: failures(run).slice(0, 20).map(item => ({ dependency: item.dependency, probe: item.probe, shopId: item.shopId, status: item.status, error: item.error?.message || '' })),
    };
    try {
      await env.DB.prepare(
        'INSERT INTO audit_log (id, shop_id, actor_id, actor_email, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, 'platform', actor?.userId || 'healthcheck-cron', actor?.email || 'cron', JSON.stringify(event), run.finishedAt).run();
      storage.auditId = id;
      storage.stored = true;
    } catch (error) {
      storage.errors.push({ store: 'd1', ...errorPayload(error) });
    }
  }
  return storage;
}

export function healthEmailText(run, storage = {}) {
  const lines = [
    `ShopCrank dependency health check ${run.ok ? 'passed' : 'FAILED'}`,
    '',
    `Run: ${run.runId} (${run.trigger}${run.dryRun ? ', dry run' : ''})`,
    `Started: ${run.startedAt}`,
    `Tool contracts: v${run.contractVersion}`,
    `Results: ${Object.entries(run.counts).map(([status, count]) => `${status} ${count}`).join(', ')}`,
    storage.key ? `Log (R2): ${storage.key}` : 'Log: not stored',
    '',
  ];
  const failing = failures(run);
  if (failing.length) {
    lines.push('Failing checks:');
    for (const item of failing) {
      lines.push(`- [${item.status}] ${item.dependency} / ${item.probe}${item.shopId ? ` (shop ${item.shopId})` : ''}: ${item.error?.message || ''}`);
    }
    lines.push('');
  }
  const jsonl = toJsonl(run.entries);
  lines.push('JSONL log:', jsonl.length > MAX_EMAIL_JSONL ? `${jsonl.slice(0, MAX_EMAIL_JSONL)}\n… truncated; full log in R2.` : jsonl);
  return lines.join('\n');
}

/**
 * Email the run to HEALTHCHECK_EMAIL_TO (default SUPPORT_EMAIL_TO) through the
 * Worker's EMAIL binding. HEALTHCHECK_EMAIL_MODE: "failures" (default), "always", "off".
 */
export async function deliverHealthReport(env, run, storage = {}, { force = false } = {}) {
  if (run.dryRun) return { sent: false, reason: 'dry_run' };
  const mode = String(env.HEALTHCHECK_EMAIL_MODE || 'failures').toLowerCase();
  if (!force && mode === 'off') return { sent: false, reason: 'disabled' };
  if (!force && mode !== 'always' && run.ok) return { sent: false, reason: 'healthy' };
  const to = String(env.HEALTHCHECK_EMAIL_TO || env.SUPPORT_EMAIL_TO || '').trim();
  const from = String(env.HEALTHCHECK_EMAIL_FROM || env.AUTH_EMAIL_FROM || DEFAULT_AUTH_EMAIL_FROM).trim();
  if (typeof env.EMAIL?.send !== 'function') return { sent: false, reason: 'email_not_configured' };
  if (!EMAIL_PATTERN.test(to) || !EMAIL_PATTERN.test(from)) return { sent: false, reason: 'invalid_address' };
  const failing = failures(run);
  const down = failing.filter(item => item.status === 'down').length;
  try {
    await env.EMAIL.send({
      to,
      from,
      subject: `[ShopCrank] Health check ${run.ok ? 'passed' : 'failing'}: ${down} down, ${failing.length - down} degraded`,
      text: healthEmailText(run, storage),
    });
    return { sent: true, to };
  } catch (error) {
    return { sent: false, reason: 'send_failed', error: errorPayload(error) };
  }
}

export async function runScheduledHealthCheck(env, dependencies = {}) {
  const run = await runHealthCheck(env, { ...dependencies, trigger: 'cron' });
  const storage = await persistHealthRun(env, run);
  const delivery = await deliverHealthReport(env, run, storage);
  console.log(JSON.stringify({ message: 'dependency health check cron', runId: run.runId, ok: run.ok, counts: run.counts, logKey: storage.key || null, email: delivery }));
  if (!run.ok) console.warn(JSON.stringify({ message: 'dependency health check failing', runId: run.runId, failures: failures(run).map(item => ({ dependency: item.dependency, probe: item.probe, shopId: item.shopId, status: item.status, error: item.error })) }));
  return { run, storage, delivery };
}

async function listRuns(env, limit = 20) {
  if (!env.FILES?.list) return [];
  const listing = await env.FILES.list({ prefix: HEALTH_LOG_PREFIX, limit, include: ['customMetadata'] });
  return (listing.objects || []).map((object) => {
    const meta = object.customMetadata || {};
    let counts = null;
    try { counts = JSON.parse(meta.counts || 'null'); } catch { counts = null; }
    return {
      name: object.key.slice(HEALTH_LOG_PREFIX.length).replace(/\.jsonl$/, ''),
      runId: meta.runId || '',
      trigger: meta.trigger || '',
      ok: meta.ok === 'true',
      startedAt: meta.startedAt || (object.uploaded ? new Date(object.uploaded).toISOString() : ''),
      counts,
      size: object.size,
    };
  });
}

function parseJsonl(text) {
  return String(text || '').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Platform-owner endpoints:
 *   GET  /admin/health-check              recent runs, schedule, contract version
 *   GET  /admin/health-check/runs/:name   one stored run (?format=jsonl for the raw log)
 *   POST /admin/health-check              { dryRun = true, notify = false } run now
 */
export async function handleHealthCheckAdmin(request, env, context, segments, dependencies = {}) {
  if (context.role !== 'super_admin') throw new HttpError(403, 'Only the ShopCrank platform owner can run health checks');
  const [, , section, name] = segments.map(item => decodeURIComponent(item));
  if (!section && request.method === 'GET') {
    return json({
      schedule: HEALTH_CHECK_CRON,
      contractVersion: TOOL_CONTRACTS_VERSION,
      changelog: TOOL_CONTRACTS_CHANGELOG,
      dependencies: DEPENDENCIES,
      emailMode: String(env.HEALTHCHECK_EMAIL_MODE || 'failures'),
      runs: await listRuns(env),
    });
  }
  if (section === 'runs' && name && request.method === 'GET') {
    if (!RUN_NAME.test(name)) throw new HttpError(400, 'Unknown health check run');
    const object = await env.FILES?.get?.(`${HEALTH_LOG_PREFIX}${name}.jsonl`);
    if (!object) throw new HttpError(404, 'Health check run not found');
    const text = await object.text();
    if (new URL(request.url).searchParams.get('format') === 'jsonl') {
      return new Response(text, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="shopcrank-health-${name}.jsonl"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return json({ name, entries: parseJsonl(text) });
  }
  if (!section && request.method === 'POST') {
    const body = await requestJson(request).catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const run = await runHealthCheck(env, { ...dependencies, dryRun, trigger: 'manual' });
    const storage = await persistHealthRun(env, run, { userId: context.userId, email: context.email });
    const delivery = body.notify === true ? await deliverHealthReport(env, run, storage, { force: true }) : { sent: false, reason: 'not_requested' };
    return json({ ...run, storage, delivery });
  }
  throw new HttpError(405, 'Method not allowed');
}
