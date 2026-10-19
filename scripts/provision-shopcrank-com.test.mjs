#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPYABLE_SECRET_ENV,
  CloudflareApiError,
  PAGES_PROJECT,
  WORKER_NAME,
  createCloudflareClient,
  desiredState,
  desiredWorkerRoutes,
  googleOAuthRemaining,
  isAlreadyConfiguredError,
  isDesiredApiRoute,
  isWholeHostnameRoute,
  parseArgs,
  provisionShopcrankCom,
  routesToCreate,
  secretCopyPlan,
  shouldDeleteWorkerRoute,
} from './provision-shopcrank-com.mjs';

test('parseArgs accepts json and report flags', () => {
  assert.deepEqual(parseArgs(['--json', '--report', '/tmp/out.json']), {
    help: false,
    json: true,
    reportPath: '/tmp/out.json',
  });
});

test('desired state keeps Pages on www and Worker on /api/* plus /downloads/*', () => {
  const state = desiredState();
  assert.equal(state.zone, 'shopcrank.com');
  assert.equal(state.pagesProject, PAGES_PROJECT);
  assert.deepEqual(state.pagesDomains, ['www.shopcrank.com', 'shopcrank.com']);
  assert.equal(state.worker, 'shopcrank-api');
  assert.deepEqual(state.workerRoutes, [
    'www.shopcrank.com/api/*',
    'shopcrank.com/api/*',
    'www.shopcrank.com/downloads/*',
    'shopcrank.com/downloads/*',
  ]);
  assert.ok(!state.workerRoutes.some((pattern) => /\/\*$/.test(pattern) && !pattern.includes('/api/') && !pattern.includes('/downloads/')));
  assert.deepEqual(desiredWorkerRoutes(), state.workerRoutes);
});

test('route classifiers keep /api/* and /downloads/* and reject whole-host bindings', () => {
  assert.equal(isDesiredApiRoute('www.shopcrank.com/api/*'), true);
  assert.equal(isDesiredApiRoute('shopcrank.com/api/*'), true);
  assert.equal(isDesiredApiRoute('https://www.shopcrank.com/api/*'), true);
  assert.equal(isDesiredApiRoute('www.shopcrank.com/downloads/*'), true);
  assert.equal(isDesiredApiRoute('shopcrank.com/downloads/*'), true);
  assert.equal(isDesiredApiRoute('www.shopcrank.com/*'), false);
  assert.equal(isDesiredApiRoute('www.shopcrank.com'), false);

  assert.equal(isWholeHostnameRoute('www.shopcrank.com'), true);
  assert.equal(isWholeHostnameRoute('www.shopcrank.com/'), true);
  assert.equal(isWholeHostnameRoute('www.shopcrank.com/*'), true);
  assert.equal(isWholeHostnameRoute('shopcrank.com/*'), true);
  assert.equal(isWholeHostnameRoute('*shopcrank.com/*'), true);
  assert.equal(isWholeHostnameRoute('www.shopcrank.com/api/*'), false);
  assert.equal(isWholeHostnameRoute('admin.shopcrank.com/*'), false);
});

test('shouldDeleteWorkerRoute strips whole-host and leftover Worker paths', () => {
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'www.shopcrank.com/*', script: 'shopcrank-api' }), true);
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'www.shopcrank.com', script: 'pages-something' }), true);
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' }), false);
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'www.shopcrank.com/downloads/*', script: 'shopcrank-api' }), false);
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'www.shopcrank.com/downloads/*', script: 'other-worker' }), false);
  assert.equal(shouldDeleteWorkerRoute({ pattern: 'admin.shopcrank.com/*', script: 'shopcrank-api' }), false);
});

test('routesToCreate adds missing /api/* and /downloads/* bindings', () => {
  assert.deepEqual(
    routesToCreate([{ pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' }]),
    ['shopcrank.com/api/*', 'www.shopcrank.com/downloads/*', 'shopcrank.com/downloads/*'],
  );
  assert.deepEqual(
    routesToCreate([
      { pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' },
      { pattern: 'shopcrank.com/api/*', script: 'shopcrank-api' },
    ]),
    ['www.shopcrank.com/downloads/*', 'shopcrank.com/downloads/*'],
  );
  assert.deepEqual(
    routesToCreate([
      { pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' },
      { pattern: 'shopcrank.com/api/*', script: 'shopcrank-api' },
      { pattern: 'www.shopcrank.com/downloads/*', script: 'shopcrank-api' },
      { pattern: 'shopcrank.com/downloads/*', script: 'shopcrank-api' },
    ]),
    [],
  );
});

test('already-configured Cloudflare errors are treated as success', () => {
  assert.equal(isAlreadyConfiguredError(409, []), true);
  assert.equal(isAlreadyConfiguredError(400, [{ message: 'already exists' }]), true);
  assert.equal(isAlreadyConfiguredError(400, [{ message: 'Domain already associated' }]), true);
  assert.equal(isAlreadyConfiguredError(400, [{ message: 'bad request' }]), false);
});

test('secretCopyPlan puts env values and reports unreadable mechpro-api names', () => {
  const plan = secretCopyPlan({
    sourceNames: ['GOOGLE_CLIENT_ID', 'INTEGRATION_ENCRYPTION_KEY', 'UNDOCUMENTED_SECRET'],
    destNames: ['GOOGLE_CLIENT_ID'],
    env: {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    },
  });
  assert.deepEqual(plan.put, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  assert.deepEqual(plan.missingValues, ['INTEGRATION_ENCRYPTION_KEY', 'UNDOCUMENTED_SECRET']);
  assert.ok(COPYABLE_SECRET_ENV.DIAGNOSTICS_SIGNING_PRIVATE_KEY);
});

test('Google OAuth remaining step is console-only', () => {
  const remaining = googleOAuthRemaining();
  assert.equal(remaining.javascriptOrigin, 'https://www.shopcrank.com');
  assert.equal(remaining.redirectUri, 'https://www.shopcrank.com/api/auth/google/callback');
  assert.match(remaining.message, /Google Cloud/);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('createCloudflareClient treats already-exists as success', async () => {
  const client = createCloudflareClient({
    apiToken: 'token',
    fetchImpl: async () => jsonResponse(409, {
      success: false,
      errors: [{ message: 'already exists' }],
    }),
  });
  const payload = await client.request('POST', '/zones');
  assert.equal(payload.success, true);
  assert.equal(payload.alreadyConfigured, true);
});

test('createCloudflareClient throws on real API failures', async () => {
  const client = createCloudflareClient({
    apiToken: 'token',
    fetchImpl: async () => jsonResponse(403, {
      success: false,
      errors: [{ message: 'Authentication error' }],
    }),
  });
  await assert.rejects(
    () => client.request('GET', '/zones'),
    (error) => error instanceof CloudflareApiError && error.status === 403,
  );
});

test('provisionShopcrankCom attaches Pages www, /api and /downloads routes, email, R2, and secrets', async () => {
  const calls = [];
  const store = {
    zones: [],
    pagesDomains: [],
    workerDomains: [
      { id: 'dom-www', hostname: 'www.shopcrank.com', service: 'shopcrank-api' },
    ],
    routes: [
      { id: 'rt-all', pattern: 'www.shopcrank.com/*', script: 'shopcrank-api' },
    ],
    r2: [{ name: 'mechpro-files' }],
    secrets: {
      'mechpro-api': [{ name: 'GOOGLE_CLIENT_ID', type: 'secret_text' }, { name: 'INTEGRATION_ENCRYPTION_KEY', type: 'secret_text' }],
      'shopcrank-api': [],
    },
    routing: { enabled: false, status: 'unconfigured' },
    sending: [],
    addresses: [],
    putSecrets: [],
  };

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/client/v4', '');
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });

    if (method === 'GET' && path === '/zones') {
      const name = parsed.searchParams.get('name');
      return jsonResponse(200, { success: true, result: store.zones.filter((zone) => !name || zone.name === name) });
    }
    if (method === 'POST' && path === '/zones') {
      const zone = {
        id: 'zone-1',
        name: 'shopcrank.com',
        status: 'pending',
        name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'],
        account: { id: 'acct-1' },
      };
      store.zones.push(zone);
      return jsonResponse(200, { success: true, result: zone });
    }
    if (method === 'GET' && path === '/accounts/acct-1/pages/projects/shopcrank-dispatch/domains') {
      return jsonResponse(200, { success: true, result: store.pagesDomains });
    }
    if (method === 'POST' && path === '/accounts/acct-1/pages/projects/shopcrank-dispatch/domains') {
      const domain = { name: JSON.parse(init.body).name, status: 'pending' };
      store.pagesDomains.push(domain);
      return jsonResponse(200, { success: true, result: domain });
    }
    if (method === 'GET' && path === '/accounts/acct-1/workers/domains') {
      return jsonResponse(200, { success: true, result: store.workerDomains });
    }
    if (method === 'DELETE' && path.startsWith('/accounts/acct-1/workers/domains/')) {
      const id = path.split('/').at(-1);
      store.workerDomains = store.workerDomains.filter((domain) => domain.id !== id);
      return jsonResponse(200, { success: true, result: null });
    }
    if (method === 'GET' && path === '/zones/zone-1/workers/routes') {
      return jsonResponse(200, { success: true, result: store.routes });
    }
    if (method === 'DELETE' && path.startsWith('/zones/zone-1/workers/routes/')) {
      const id = path.split('/').at(-1);
      store.routes = store.routes.filter((route) => route.id !== id);
      return jsonResponse(200, { success: true, result: null });
    }
    if (method === 'POST' && path === '/zones/zone-1/workers/routes') {
      const route = { id: `rt-${store.routes.length}`, ...JSON.parse(init.body) };
      store.routes.push(route);
      return jsonResponse(200, { success: true, result: route });
    }
    if (method === 'GET' && path === '/accounts/acct-1/r2/buckets') {
      return jsonResponse(200, { success: true, result: { buckets: store.r2 } });
    }
    if (method === 'POST' && path === '/accounts/acct-1/r2/buckets') {
      const bucket = { name: JSON.parse(init.body).name };
      store.r2.push(bucket);
      return jsonResponse(200, { success: true, result: bucket });
    }
    if (method === 'GET' && path === '/zones/zone-1/email/routing') {
      return jsonResponse(200, { success: true, result: store.routing });
    }
    if (method === 'POST' && path === '/zones/zone-1/email/routing/enable') {
      store.routing = { enabled: true, status: 'ready' };
      return jsonResponse(200, { success: true, result: store.routing });
    }
    if (method === 'GET' && path === '/zones/zone-1/email/sending/subdomains') {
      return jsonResponse(200, { success: true, result: store.sending });
    }
    if (method === 'POST' && path === '/zones/zone-1/email/sending/subdomains') {
      const row = { name: JSON.parse(init.body).name, enabled: true, tag: 'send-1' };
      store.sending.push(row);
      return jsonResponse(200, { success: true, result: row });
    }
    if (method === 'GET' && path === '/accounts/acct-1/email/routing/addresses') {
      return jsonResponse(200, { success: true, result: store.addresses });
    }
    if (method === 'POST' && path === '/accounts/acct-1/email/routing/addresses') {
      const row = { id: 'addr-1', email: JSON.parse(init.body).email, verified: '2026-10-14T00:00:00Z' };
      store.addresses.push(row);
      return jsonResponse(200, { success: true, result: row });
    }
    if (method === 'PATCH' && path === '/accounts/acct-1/email/routing/addresses/addr-1') {
      const row = { ...store.addresses[0], verified: '2026-10-14T00:00:00Z' };
      store.addresses[0] = row;
      return jsonResponse(200, { success: true, result: row });
    }
    if (method === 'GET' && path === '/accounts/acct-1/workers/scripts/mechpro-api/secrets') {
      return jsonResponse(200, { success: true, result: store.secrets['mechpro-api'] });
    }
    if (method === 'GET' && path === '/accounts/acct-1/workers/scripts/shopcrank-api/secrets') {
      return jsonResponse(200, { success: true, result: store.secrets['shopcrank-api'] });
    }
    if (method === 'PUT' && path === '/accounts/acct-1/workers/scripts/shopcrank-api/secrets') {
      const body = JSON.parse(init.body);
      assert.equal(body.type, 'secret_text');
      assert.ok(body.text);
      store.putSecrets.push(body.name);
      store.secrets['shopcrank-api'].push({ name: body.name, type: 'secret_text' });
      return jsonResponse(200, { success: true, result: { name: body.name, type: 'secret_text' } });
    }
    return jsonResponse(404, { success: false, errors: [{ message: `unhandled ${method} ${path}` }] });
  };

  const client = createCloudflareClient({ apiToken: 'token', fetchImpl });
  const logs = [];
  const report = await provisionShopcrankCom({
    client,
    accountId: 'acct-1',
    env: {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    },
    logger: { info(message) { logs.push(message); } },
  });

  assert.equal(report.ok, true);
  assert.equal(report.steps.zone.action, 'created');
  assert.deepEqual(report.steps.pages.added, ['www.shopcrank.com', 'shopcrank.com']);
  assert.equal(report.steps.workerDomains.detached[0].hostname, 'www.shopcrank.com');
  assert.deepEqual(report.steps.workerRoutes.created, [
    'www.shopcrank.com/api/*',
    'shopcrank.com/api/*',
    'www.shopcrank.com/downloads/*',
    'shopcrank.com/downloads/*',
  ]);
  assert.deepEqual(report.steps.workerRoutes.deleted, [
    { pattern: 'www.shopcrank.com/*', script: 'shopcrank-api' },
  ]);
  assert.ok(!report.steps.workerRoutes.routes.some((route) => route.pattern === 'www.shopcrank.com/*'));
  assert.ok(report.steps.workerRoutes.routes.some((route) => route.pattern === 'www.shopcrank.com/downloads/*'));
  assert.ok(report.steps.r2.created.includes('shopcrank-files'));
  assert.ok(report.steps.r2.created.includes('shopcrank-files-preview'));
  assert.deepEqual(report.steps.r2.legacyPresent, ['mechpro-files']);
  assert.equal(report.steps.email.sending.enabled, true);
  assert.equal(report.steps.email.destination.email, 'noreply@shopcrank.com');
  assert.equal(report.steps.email.destination.verified, true);
  assert.deepEqual(
    [...store.putSecrets].toSorted((left, right) => String(left).localeCompare(String(right))),
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  );
  assert.deepEqual(report.steps.secrets.missingValues, ['INTEGRATION_ENCRYPTION_KEY']);
  assert.equal(report.remaining[0].kind, 'google_oauth');
  assert.equal(report.remaining[1].kind, 'nameservers');
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/zones/zone-1/workers/routes' && call.body.pattern === 'www.shopcrank.com/api/*'));
  assert.ok(!calls.some((call) => call.body?.pattern === 'www.shopcrank.com/*' && call.method === 'POST'));
  assert.ok(logs.length > 0);
  assert.equal(WORKER_NAME, 'shopcrank-api');
});
