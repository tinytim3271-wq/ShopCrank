import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { matchOpenLaborJob, parseVehicleText, searchOpenLabor } from '../src/integrations/open-labor.mjs';
import { getLaborProviderStatus, searchLicensedLabor } from '../src/integrations/labor.mjs';
import { createLaborGuideHandlers } from '../src/integrations/labor-guide.mjs';

// Trimmed copy of a real free-key reply for a 2018 Camry: every job locked except front pads + rotors.
const CATALOG = JSON.parse(readFileSync(new URL('./fixtures/open-labor-camry-2018.json', import.meta.url), 'utf8'));
const JOBS = CATALOG.data.engines[0].laborTimes;
const AC_REPLY = {
  data: { make: 'Toyota', model: 'Camry', engines: [
    { engine: '2.5L I4', laborTimes: [{ job: 'AC Compressor', jobSlug: 'ac-compressor', category: 'hvac', hours: 2.5, lowRange: 2, highRange: 3.5, confidence: 'high' }] },
    { engine: '2.5L I4 Hybrid', laborTimes: [{ job: 'AC Compressor', jobSlug: 'ac-compressor', category: 'hvac', hours: 2.4, lowRange: 2, highRange: 2.8, confidence: 'high' }] },
    { engine: '3.5L V6', laborTimes: [{ job: 'AC Compressor', jobSlug: 'ac-compressor', category: 'hvac', hours: 2.5, lowRange: 2, highRange: 3.5, confidence: 'estimated' }] },
  ] },
  meta: {}, error: null,
};

function fakeApi({ status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, key: init.headers?.['x-api-key'] });
    if (parsed.host === 'vpic.nhtsa.dot.gov') return Response.json({ Results: [{ ModelYear: '2018', Make: 'TOYOTA', Model: 'Camry', DisplacementL: '3.5', EngineCylinders: '6' }] });
    if (status !== 200) return Response.json({ data: null, error: { code: 'RATE_LIMIT_EXCEEDED' } }, { status });
    return Response.json(parsed.searchParams.get('job') === 'ac-compressor' ? AC_REPLY : CATALOG);
  };
  return { fetcher, calls, apiCalls: () => calls.filter(call => call.url.host === 'openlaborproject.com') };
}

const env = (extra = {}) => ({ DB: createD1(), OPEN_LABOR_API_KEY: 'olp-test-key', ...extra });

test('shop wording finds the right catalog job; vague or wrong words find none', () => {
  const cases = {
    'front brake pads': 'brake-pads-front',
    'front brakes': 'brake-pads-front',
    'rear brakes': 'brake-pads-rear',
    'Replace A/C compressor': 'ac-compressor',
    'R&R starter': 'starter',
    'starter motor': 'starter',
    'diagnose noise': 'noise-diagnosis',
    'front struts': 'front-struts-pair',
    'o2 sensor upstream': 'o2-sensor-upstream',
    'ac-compressor': 'ac-compressor',
  };
  for (const [query, slug] of Object.entries(cases)) assert.equal(matchOpenLaborJob(query, JOBS)?.jobSlug, slug, query);
  assert.equal(matchOpenLaborJob('timing belt', JOBS), null, 'a chain engine has no timing belt; "belt" alone must not pick Seat Belt');
  assert.equal(matchOpenLaborJob('rear struts', JOBS), null, 'a rear request must not select front struts');
  assert.equal(matchOpenLaborJob('o2 sensor downstream', JOBS), null, 'a downstream request must not select an upstream sensor');
  assert.equal(matchOpenLaborJob('front', JOBS), null);
  assert.equal(matchOpenLaborJob('', JOBS), null);
});

test('a vehicle string splits into year, make, model', () => {
  assert.deepEqual(parseVehicleText('2018 Toyota Camry SE'), { year: '2018', make: 'Toyota', model: 'Camry' });
  assert.deepEqual(parseVehicleText('Camry'), {});
});

test('a lookup reads the catalog, then the one job, sends the key, and caches both for 30 days', async () => {
  const api = fakeApi();
  const e = env();
  const results = await searchOpenLabor(e, { year: 2018, make: 'Toyota', model: 'Camry', query: 'replace AC compressor' }, { fetcher: api.fetcher });
  assert.equal(api.apiCalls().length, 2);
  assert.equal(api.apiCalls()[0].url.searchParams.get('job'), null);
  assert.equal(api.apiCalls()[1].url.searchParams.get('job'), 'ac-compressor');
  assert.ok(api.apiCalls().every(call => call.key === 'olp-test-key'));
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], {
    hours: 2.5, lowRange: 2, highRange: 3.5, confidence: 'high', verified: true, job: 'AC Compressor', jobSlug: 'ac-compressor',
    engine: '2.5L I4', description: 'AC Compressor (2.5L I4)', source: 'Open Labor Project — not book time (high confidence, range 2–3.5 h)', provider: 'Open Labor Project', bookTime: false,
  });
  assert.equal(results[2].verified, false, 'estimated rows are never marked verified');
  assert.equal(results[2].source, 'Open Labor Project — not book time (estimated, range 2–3.5 h)');

  const again = await searchOpenLabor(e, { year: '2018', make: 'toyota', model: 'camry', query: 'a/c compressor' }, { fetcher: api.fetcher });
  assert.equal(api.apiCalls().length, 2, 'the free key allows 7 calls a day, so repeat lookups come from the cache');
  assert.deepEqual(again, results);
});

test('the engine narrows the answer; a hybrid ask gets the hybrid row', async () => {
  const api = fakeApi();
  const v6 = await searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', engine: '3.5L V6', query: 'ac compressor' }, { fetcher: api.fetcher });
  assert.deepEqual(v6.map(row => row.engine), ['3.5L V6']);
  const hybrid = await searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', engine: '2.5L hybrid', query: 'ac compressor' }, { fetcher: fakeApi().fetcher });
  assert.deepEqual(hybrid.map(row => row.engine), ['2.5L I4 Hybrid']);
  const unmatchedHybrid = await searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', engine: '3.5L hybrid', query: 'ac compressor' }, { fetcher: fakeApi().fetcher });
  assert.deepEqual(unmatchedHybrid, [], 'an explicit engine mismatch must not return another engine’s time');
});

test('with a paid key (every job unlocked in the catalog) a lookup takes one call', async () => {
  const unlocked = structuredClone(CATALOG);
  for (const engine of unlocked.data.engines) for (const row of engine.laborTimes) Object.assign(row, { hours: 1.2, lowRange: 1, highRange: 1.5, confidence: 'estimated', locked: false });
  const calls = [];
  const fetcher = async url => { calls.push(String(url)); return Response.json(unlocked); };
  const results = await searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', query: 'starter' }, { fetcher });
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map(row => [row.engine, row.hours]), [['2.5L I4', 1.2], ['2.5L I4 Hybrid', 1.2], ['3.5L V6', 1.2]]);
});

test('the estimate editor sends one vehicle string; a bare VIN is decoded first', async () => {
  const fromString = await searchOpenLabor(env(), { model: '2018 Toyota Camry', query: 'ac compressor' }, { fetcher: fakeApi().fetcher });
  assert.equal(fromString.length, 3);
  const api = fakeApi();
  const fromVin = await searchOpenLabor(env(), { vin: '4T1B11HK5JU000001', query: 'ac compressor' }, { fetcher: api.fetcher });
  assert.deepEqual(fromVin.map(row => row.engine), ['3.5L V6'], 'the decoded 3.5L picks the V6 row');
  assert.equal(api.apiCalls()[0].url.searchParams.get('make'), 'TOYOTA');
  const completeVehicleWithVin = await searchOpenLabor(env(), { model: '2018 Toyota Camry', vin: '4T1B11HK5JU000001', query: 'ac compressor' }, { fetcher: fakeApi().fetcher });
  assert.deepEqual(completeVehicleWithVin.map(row => row.engine), ['3.5L V6'], 'decode VIN engine even when year, make, and model are already known');
});

test('no key, no vehicle or no job means no call', async () => {
  const api = fakeApi();
  assert.deepEqual(await searchOpenLabor({ DB: createD1() }, { year: 2018, make: 'Toyota', model: 'Camry', query: 'starter' }, { fetcher: api.fetcher }), []);
  assert.deepEqual(await searchOpenLabor(env(), { query: 'starter' }, { fetcher: api.fetcher }), []);
  assert.deepEqual(await searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', query: 'timing belt' }, { fetcher: api.fetcher }), []);
  assert.equal(api.apiCalls().length, 1, 'only the catalog for the last one');
});

test('the daily limit is reported clearly and labor search falls back to the shop estimate', async () => {
  await assert.rejects(
    searchOpenLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', query: 'starter' }, { fetcher: fakeApi({ status: 429 }).fetcher }),
    error => error.code === 'rate_limited' && /limit reached/.test(error.message),
  );
  const results = await searchLicensedLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', query: 'starter' }, { fetch: fakeApi({ status: 429 }).fetcher });
  assert.deepEqual(results.map(row => row.source), ['Unverified shop estimate']);
});

test('labor search (assistant, phone agent, estimate editor) uses Open Labor when no licensed guide answers', async () => {
  const results = await searchLicensedLabor(env(), { year: 2018, make: 'Toyota', model: 'Camry', query: 'ac compressor' }, { fetch: fakeApi().fetcher });
  assert.equal(results[0].provider, 'Open Labor Project');
  assert.equal(results[0].hours, 2.5);
  assert.equal(getLaborProviderStatus(env()).openlabor.configured, true);
  assert.equal(getLaborProviderStatus({}).openlabor.configured, false);
  await assert.rejects(searchLicensedLabor(env(), { query: 'x' }, { provider: 'nope', fetch: fakeApi().fetcher }), /Unknown labor provider/);
});

test('the labor guide lookup returns Open Labor lines labeled not book time, before any web average', async () => {
  const e = { ...env(), LABOR_WEB_SEARCH_API_KEY: 'brave-key' };
  const api = fakeApi();
  e.fetch = api.fetcher;
  const handle = createLaborGuideHandlers({ getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => {}, requireRole: () => {}, recordAudit: async () => {} });
  const request = new Request('https://x/api/integrations/labor-guide/search', { method: 'POST', body: JSON.stringify({ keyword: 'ac compressor', year: '2018', make: 'Toyota', model: 'Camry', engine: '3.5L', laborRate: 140 }) });
  const response = await handle(request, e, { shopId: 'shop-1', role: 'admin' }, ['integrations', 'labor-guide', 'search']);
  const body = await response.json();
  assert.equal(body.provider, 'open_labor');
  assert.equal(body.bookTime, false);
  assert.equal(body.label, 'Open Labor Project — not book time');
  assert.equal(body.lines.length, 1);
  assert.equal(body.lines[0].hours, 2.5);
  assert.equal(body.lines[0].total, 350);
  assert.match(body.lines[0].notes, /not book time \(estimated, range 2–3.5 h\)/);
  assert.ok(!api.calls.some(call => call.url.host.includes('brave')), 'no web search when Open Labor answered');
});
