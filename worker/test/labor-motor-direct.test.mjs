import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaborGuideHandlers, platformLaborStatus } from '../src/integrations/labor-guide.mjs';
import { motorAuthHeaders, motorLaborUrl, motorPlatformConfig, normalizeMotorOperation } from '../src/integrations/motor-direct.mjs';
import { LABOR_GUIDE_SECRET_NAME, laborBookTimeBanner } from '../../src/modules/labor-guide.js';
import { PARTSTECH_SECRET_NAME } from '../../src/modules/partstech.js';

const VIN = '1FTFW1E50NFA00001';
const platformEnv = {
  MOTOR_API_BASE_URL: 'https://motor.example.test/v1/',
  MOTOR_LABOR_PATH: 'Information/Vehicles/VIN/{vin}/Labor',
  MOTOR_PUBLIC_KEY: 'pub-123',
  MOTOR_PRIVATE_KEY: 'priv-456',
};

function harness(secrets = {}) {
  const audits = [];
  const handler = createLaborGuideHandlers({
    getSecret: async (_shop, name) => secrets[name] ?? null,
    saveSecret: async (_env, _shop, name, value) => { secrets[name] = value; },
    deleteSecret: async (_env, _shop, name) => { delete secrets[name]; },
    requireRole: () => {},
    recordAudit: async (_env, _ctx, event) => { audits.push(event); },
  });
  const search = (env, body) => handler(new Request('https://x.test/api/integrations/labor-guide/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, { shopId: 'shop-1', userId: 'u1', role: 'admin' }, ['integrations', 'labor-guide', 'search']).then(response => response.json());
  return { search, audits, secrets };
}

function motorFetch(calls, operations = [{ ID: 'op-1', Description: 'Pads, front, replace', BaseLaborTime: 1.4 }]) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ Body: operations });
  };
}

test('MOTOR Shared auth signs public key, method, epoch, and path with the private key', async () => {
  const config = motorPlatformConfig(platformEnv);
  const headers = await motorAuthHeaders(config, { method: 'GET', path: '/v1/x', epochSeconds: 1_700_000_000 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('priv-456'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('pub-123\nGET\n1700000000\n/v1/x'))).toString('base64');
  assert.equal(headers.Authorization, `Shared pub-123:${expected}`);
  assert.equal(headers['X-Date'], '1700000000');
  assert.equal(motorLaborUrl(config, { vin: VIN, keyword: 'brake pads' }).toString(), `https://motor.example.test/v1/Information/Vehicles/VIN/${VIN}/Labor?searchTerm=brake+pads`);
  assert.throws(() => motorLaborUrl({ ...config, laborPath: 'https://evil.test/x' }), /relative/);
});

test('MOTOR operations accept PascalCase and camelCase and drop invalid hours', () => {
  assert.equal(normalizeMotorOperation({ Description: 'A', BaseLaborTime: '2.1' }).hours, 2.1);
  assert.equal(normalizeMotorOperation({ description: 'B', hours: 0.5 }).description, 'B');
  assert.equal(normalizeMotorOperation({ Description: 'C', BaseLaborTime: -1 }), null);
});

test('with no shop provider, estimates use ShopCrank\'s MOTOR license as labeled book time', async () => {
  const calls = [];
  const { search, audits } = harness();
  const result = await search({ ...platformEnv, fetch: motorFetch(calls) }, { vin: VIN, keyword: 'front pads', laborRate: 150 });
  assert.equal(result.bookTime, true);
  assert.equal(result.provider, 'motor');
  assert.equal(result.licensedBy, 'platform');
  assert.equal(result.lines[0].hours, 1.4);
  assert.equal(result.lines[0].total, 210);
  assert.equal(result.lines[0].laborGuide.bookTime, true);
  assert.match(calls[0].init.headers.Authorization, /^Shared pub-123:/);
  assert.equal(audits[0].licensedBy, 'platform');
  assert.match(laborBookTimeBanner(result), /MOTOR book time/);
  assert.match(laborBookTimeBanner(result), /included with ShopCrank/);
});

test('a shop with its own MOTOR keys signs with those keys, never PartsTech', async () => {
  const calls = [];
  const { search } = harness({
    [LABOR_GUIDE_SECRET_NAME]: JSON.stringify({ provider: 'motor', viaPartstech: false, publicKey: 'shop-pub', privateKey: 'shop-priv' }),
  });
  const env = { MOTOR_API_BASE_URL: platformEnv.MOTOR_API_BASE_URL, MOTOR_LABOR_PATH: platformEnv.MOTOR_LABOR_PATH, fetch: motorFetch(calls) };
  const result = await search(env, { vin: VIN, keyword: 'pads', laborRate: 100 });
  assert.equal(result.licensedBy, 'shop');
  assert.match(calls[0].init.headers.Authorization, /^Shared shop-pub:/);
  assert.ok(calls.every(call => !call.url.includes('partstech')));
});

test('MOTOR via PartsTech results are stamped as book time', async () => {
  const calls = [];
  const { search } = harness({
    [LABOR_GUIDE_SECRET_NAME]: JSON.stringify({ provider: 'motor', viaPartstech: true }),
    [PARTSTECH_SECRET_NAME]: JSON.stringify({ userId: 'u', userKey: 'k', partnerId: 'p', partnerKey: 'pk' }),
  });
  const fetcher = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/oauth/access')) return Response.json({ accessToken: 't', expiresIn: 3600 });
    return Response.json({ operations: [{ id: 'pt-1', description: 'Rotors, front', hours: 1.1 }] });
  };
  const result = await search({ fetch: fetcher }, { vin: VIN, keyword: 'rotors', laborRate: 100 });
  assert.equal(result.bookTime, true);
  assert.equal(result.licensedBy, 'partstech');
  assert.equal(result.lines[0].laborGuide.bookTime, true);
});

test('ALLDATA uses the platform adapter when configured and fails closed otherwise', async () => {
  const alldataEnv = {
    ALLDATA_LABOR_BASE_URL: 'https://alldata.example.test/',
    ALLDATA_LABOR_SEARCH_PATH: 'labor',
    ALLDATA_LABOR_API_KEY: 'ad-key',
  };
  assert.deepEqual(platformLaborStatus(alldataEnv), { motor: false, alldata: true });
  const secrets = { [LABOR_GUIDE_SECRET_NAME]: JSON.stringify({ provider: 'alldata', subscriptionId: 'sub-1' }) };
  const { search } = harness(secrets);
  const result = await search({ ...alldataEnv, fetch: async () => Response.json({ results: [{ laborHours: 2, operation: 'Water pump' }] }) }, { vin: VIN, keyword: 'water pump', laborRate: 100 });
  assert.equal(result.provider, 'alldata');
  assert.equal(result.lines[0].hours, 2);
  await assert.rejects(() => search({}, { vin: VIN, keyword: 'water pump' }), error => error.status === 501 && /not enabled/.test(error.message));
});

test('with no book source at all, the estimate falls back to the labeled web average', async () => {
  const { search } = harness();
  const result = await search({}, { year: 2022, make: 'Ford', model: 'F-150', keyword: 'front pads' });
  assert.equal(result.provider, 'web_estimate');
  assert.notEqual(result.bookTime, true);
});
