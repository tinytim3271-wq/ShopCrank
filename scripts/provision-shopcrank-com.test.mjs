#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPYABLE_SECRET_ENV,
  CloudflareApiError,
  LEGACY_ZONE,
  PAGES_PROJECT,
  SUPPORT_EMAIL,
  WORKER_NAME,
  createCloudflareClient,
  desiredLegacyWorkerRoutes,
  desiredState,
  desiredWorkerRoutes,
  ensureDnsRecords,
  googleOAuthRemaining,
  isAlreadyConfiguredError,
  isDesiredApiRoute,
  isLegacyApiRoute,
  isLegacyHostRoute,
  isLegacyWildcardRoute,
  isWholeHostnameRoute,
  legacyDnsRecords,
  legacyRoutesToCreate,
  parseArgs,
  provisionShopcrankCom,
  routesToCreate,
  secretCopyPlan,
  shouldDeleteLegacyRoute,
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

test('the legacy zone is retired to a whole-host Worker route', () => {
  assert.equal(LEGACY_ZONE, 'yourcarguy806.com');
  assert.deepEqual(desiredLegacyWorkerRoutes(), [
    'www.yourcarguy806.com/*',
    'yourcarguy806.com/*',
  ]);
  assert.equal(isLegacyApiRoute('www.yourcarguy806.com/api/*'), true);
  assert.equal(isLegacyApiRoute('yourcarguy806.com/api/*'), true);
  assert.equal(isLegacyApiRoute('www.shopcrank.com/api/*'), false);
  assert.equal(isLegacyHostRoute('www.yourcarguy806.com/*'), true);
  assert.equal(isLegacyHostRoute('yourcarguy806.com/*'), true);
  assert.equal(isLegacyHostRoute('www.yourcarguy806.com/api/*'), false);
  assert.equal(isLegacyWildcardRoute('*.yourcarguy806.com/*'), true);
  assert.equal(isLegacyWildcardRoute('*.yourcarguy806.com'), true);
  assert.equal(isLegacyWildcardRoute('www.yourcarguy806.com/api/*'), false);
});

test('the legacy wildcard Pages route is deleted and the whole host is re-pointed at the Worker', () => {
  assert.equal(shouldDeleteLegacyRoute({ pattern: '*.yourcarguy806.com/*', script: 'shopcrank-dispatch' }), true);
  assert.equal(shouldDeleteLegacyRoute({ pattern: 'www.yourcarguy806.com/*', script: 'shopcrank-api' }), false);
  assert.equal(shouldDeleteLegacyRoute({ pattern: 'www.yourcarguy806.com/*', script: 'mechpro-api' }), true);
  // The /api/* route is replaced by the whole-host route.
  assert.equal(shouldDeleteLegacyRoute({ pattern: 'www.yourcarguy806.com/api/*', script: 'shopcrank-api' }), true);
  assert.equal(shouldDeleteLegacyRoute({ pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' }), false);
});

test('legacyRoutesToCreate adds the missing whole-host bindings only', () => {
  assert.deepEqual(
    legacyRoutesToCreate([{ pattern: 'www.yourcarguy806.com/*', script: 'shopcrank-api' }]),
    ['yourcarguy806.com/*'],
  );
  assert.deepEqual(
    legacyRoutesToCreate([
      { pattern: 'www.yourcarguy806.com/*', script: 'shopcrank-api' },
      { pattern: 'yourcarguy806.com/*', script: 'shopcrank-api' },
    ]),
    [],
  );
  // An /api/* route does not count as the whole-host route.
  assert.deepEqual(
    legacyRoutesToCreate([{ pattern: 'www.yourcarguy806.com/api/*', script: 'shopcrank-api' }]),
    ['www.yourcarguy806.com/*', 'yourcarguy806.com/*'],
  );
});

test('desired state records the legacy cutover and the ShopCrank support address', () => {
  const state = desiredState();
  assert.equal(state.legacyZone, 'yourcarguy806.com');
  assert.equal(state.supportEmail, 'support@shopcrank.com');
  assert.equal(SUPPORT_EMAIL, 'support@shopcrank.com');
  assert.ok(!state.workerRoutes.some((pattern) => pattern.includes('yourcarguy806')));
});

test('legacyDnsRecords restores both legacy hostnames as proxied A records', () => {
  const records = legacyDnsRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.name).toSorted(), ['www.yourcarguy806.com', 'yourcarguy806.com']);
  for (const record of records) {
    assert.equal(record.type, 'A');
    assert.equal(record.proxied, true);
  }
});

test('ensureDnsRecords creates missing records and leaves matching ones alone', async () => {
  const calls = [];
  const existing = [{ id: 'rec-1', type: 'A', name: 'yourcarguy806.com', content: '104.21.17.176', proxied: true }];
  const client = createCloudflareClient({
    apiToken: 'token',
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      const path = new URL(url).pathname.replace('/client/v4', '');
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      if (method === 'GET' && path === '/zones/zone-1/dns_records') {
        return jsonResponse(200, { success: true, result: existing });
      }
      if (method === 'POST' && path === '/zones/zone-1/dns_records') {
        return jsonResponse(200, { success: true, result: { id: 'rec-2' } });
      }
      if (method === 'PUT' && path.startsWith('/zones/zone-1/dns_records/')) {
        return jsonResponse(200, { success: true, result: { id: 'rec-1' } });
      }
      return jsonResponse(404, { success: false, errors: [{ message: `unhandled ${method} ${path}` }] });
    },
  });

  const result = await ensureDnsRecords(client, {
    zoneId: 'zone-1',
    records: [
      { type: 'A', name: 'yourcarguy806.com', content: '104.21.17.176', proxied: true },
      { type: 'A', name: 'www.yourcarguy806.com', content: '104.21.17.188', proxied: true },
    ],
  });

  assert.equal(result.action, 'updated');
  // The matching record is left alone; only the missing one is created.
  assert.deepEqual(result.created, [{ type: 'A', name: 'www.yourcarguy806.com', content: '104.21.17.188' }]);
  assert.deepEqual(result.updated, []);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
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
    apexDnsRecords: [],
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
    if (method === 'GET' && path === '/zones/zone-1/dns_records') {
      return jsonResponse(200, { success: true, result: store.apexDnsRecords });
    }
    if (method === 'POST' && path === '/zones/zone-1/dns_records') {
      const record = { id: `apex-dns-${store.apexDnsRecords.length}`, ...JSON.parse(init.body) };
      store.apexDnsRecords.push(record);
      return jsonResponse(200, { success: true, result: record });
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

test('provisionShopcrankCom retires the legacy zone and forwards support mail', async () => {
  const calls = [];
  const store = {
    zones: [
      { id: 'zone-1', name: 'shopcrank.com', status: 'active' },
      { id: 'zone-legacy', name: 'yourcarguy806.com', status: 'active' },
    ],
    pagesDomains: [],
    workerDomains: [
      { id: 'dom-legacy-www', hostname: 'www.yourcarguy806.com', service: 'mechpro-api' },
      { id: 'dom-legacy-apex', hostname: 'yourcarguy806.com', service: 'mechpro-api' },
    ],
    routes: {
      'zone-1': [
        { id: 'rt-www', pattern: 'www.shopcrank.com/api/*', script: 'shopcrank-api' },
        { id: 'rt-apex', pattern: 'shopcrank.com/api/*', script: 'shopcrank-api' },
        { id: 'rt-dl', pattern: 'www.shopcrank.com/downloads/*', script: 'shopcrank-api' },
        { id: 'rt-dl2', pattern: 'shopcrank.com/downloads/*', script: 'shopcrank-api' },
      ],
      'zone-legacy': [
        { id: 'rt-legacy-www', pattern: 'www.yourcarguy806.com/api/*', script: 'shopcrank-api' },
        { id: 'rt-legacy-wild', pattern: '*.yourcarguy806.com/*', script: 'shopcrank-dispatch' },
      ],
    },
    mailRules: [],
    dnsRecords: [],
    apexDnsRecords: [],
    r2: [],
    secrets: { 'mechpro-api': [], 'shopcrank-api': [] },
    routing: { enabled: true, status: 'ready' },
    sending: [{ name: 'shopcrank.com', enabled: true }],
    addresses: [],
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
    const routeMatch = path.match(/^\/zones\/([^/]+)\/workers\/routes$/);
    if (method === 'GET' && routeMatch) {
      return jsonResponse(200, { success: true, result: store.routes[routeMatch[1]] || [] });
    }
    const routeDelete = path.match(/^\/zones\/([^/]+)\/workers\/routes\/([^/]+)$/);
    if (method === 'DELETE' && routeDelete) {
      const list = store.routes[routeDelete[1]] || [];
      store.routes[routeDelete[1]] = list.filter((route) => route.id !== routeDelete[2]);
      return jsonResponse(200, { success: true, result: null });
    }
    if (method === 'POST' && routeMatch) {
      const route = { id: `new-${store.routes[routeMatch[1]].length}`, ...JSON.parse(init.body) };
      store.routes[routeMatch[1]].push(route);
      return jsonResponse(200, { success: true, result: route });
    }
    if (method === 'GET' && path === '/accounts/acct-1/r2/buckets') {
      return jsonResponse(200, { success: true, result: { buckets: store.r2 } });
    }
    if (method === 'POST' && path === '/accounts/acct-1/r2/buckets') {
      store.r2.push({ name: JSON.parse(init.body).name });
      return jsonResponse(200, { success: true, result: store.r2.at(-1) });
    }
    if (method === 'GET' && path === '/zones/zone-1/email/routing') {
      return jsonResponse(200, { success: true, result: store.routing });
    }
    if (method === 'GET' && path === '/zones/zone-1/email/sending/subdomains') {
      return jsonResponse(200, { success: true, result: store.sending });
    }
    if (method === 'GET' && path === '/accounts/acct-1/email/routing/addresses') {
      return jsonResponse(200, { success: true, result: store.addresses });
    }
    if (method === 'POST' && path === '/accounts/acct-1/email/routing/addresses') {
      const row = { id: 'addr-1', email: JSON.parse(init.body).email, verified: '2026-10-21T00:00:00Z' };
      store.addresses.push(row);
      return jsonResponse(200, { success: true, result: row });
    }
    if (method === 'PATCH' && path === '/accounts/acct-1/email/routing/addresses/addr-1') {
      store.addresses[0] = { ...store.addresses[0], verified: '2026-10-21T00:00:00Z' };
      return jsonResponse(200, { success: true, result: store.addresses[0] });
    }
    if (method === 'GET' && path === '/zones/zone-1/email/routing/rules') {
      return jsonResponse(200, { success: true, result: store.mailRules });
    }
    if (method === 'POST' && path === '/zones/zone-1/email/routing/rules') {
      const body = JSON.parse(init.body);
      const rule = { id: 'rule-1', ...body };
      store.mailRules.push(rule);
      return jsonResponse(200, { success: true, result: rule });
    }
    if (method === 'GET' && path === '/zones/zone-legacy/dns_records') {
      return jsonResponse(200, { success: true, result: store.dnsRecords });
    }
    if (method === 'POST' && path === '/zones/zone-legacy/dns_records') {
      const record = { id: `dns-${store.dnsRecords.length}`, ...JSON.parse(init.body) };
      store.dnsRecords.push(record);
      return jsonResponse(200, { success: true, result: record });
    }
    if (method === 'GET' && path === '/zones/zone-1/dns_records') {
      return jsonResponse(200, { success: true, result: store.apexDnsRecords });
    }
    if (method === 'POST' && path === '/zones/zone-1/dns_records') {
      const record = { id: `apex-dns-${store.apexDnsRecords.length}`, ...JSON.parse(init.body) };
      store.apexDnsRecords.push(record);
      return jsonResponse(200, { success: true, result: record });
    }
    if (method === 'GET' && path === '/accounts/acct-1/workers/scripts/mechpro-api/secrets') {
      return jsonResponse(200, { success: true, result: [] });
    }
    if (method === 'GET' && path === '/accounts/acct-1/workers/scripts/shopcrank-api/secrets') {
      return jsonResponse(200, { success: true, result: [] });
    }
    return jsonResponse(404, { success: false, errors: [{ message: `unhandled ${method} ${path}` }] });
  };

  const client = createCloudflareClient({ apiToken: 'token', fetchImpl });
  const report = await provisionShopcrankCom({
    client,
    accountId: 'acct-1',
    env: { SUPPORT_EMAIL_FORWARD_TO: 'ops@example.test' },
    logger: { info() {} },
  });

  assert.equal(report.ok, true);
  // The legacy custom domains are detached from the old Worker.
  assert.deepEqual(
    report.steps.legacyWorkerDomains.detached.map((item) => item.hostname).toSorted(),
    ['www.yourcarguy806.com', 'yourcarguy806.com'],
  );
  // The wildcard Pages route is dropped and the whole host points at the Worker.
  assert.deepEqual(
    report.steps.legacyWorkerRoutes.deleted.toSorted((a, b) => a.pattern.localeCompare(b.pattern)),
    [
      { pattern: '*.yourcarguy806.com/*', script: 'shopcrank-dispatch' },
      { pattern: 'www.yourcarguy806.com/api/*', script: 'shopcrank-api' },
    ],
  );
  assert.ok(!report.steps.legacyWorkerRoutes.routes.some((route) => route.pattern === '*.yourcarguy806.com/*'));
  assert.ok(report.steps.legacyWorkerRoutes.routes.some(
    (route) => route.pattern === 'www.yourcarguy806.com/*' && route.script === 'shopcrank-api',
  ));
  // Support mail is forwarded to the configured mailbox.
  assert.equal(report.steps.supportMail.action, 'created');
  assert.equal(report.steps.supportMail.address, 'support@shopcrank.com');
  assert.equal(store.mailRules[0].actions[0].value[0], 'ops@example.test');
  // The legacy DNS records are restored so the redirect is reachable.
  assert.equal(report.steps.legacyDns.action, 'updated');
  assert.deepEqual(
    store.dnsRecords.map((record) => record.name).toSorted(),
    ['www.yourcarguy806.com', 'yourcarguy806.com'],
  );
  // The canonical apex resolves too.
  assert.equal(report.steps.apexDns.action, 'updated');
  assert.deepEqual(store.apexDnsRecords.map((record) => record.name), ['shopcrank.com']);
});
