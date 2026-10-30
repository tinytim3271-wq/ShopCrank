import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LaborProviderError,
  getLaborProviderStatus,
  normalizeLaborSearchInput,
  searchLicensedLabor,
} from '../src/integrations/labor.mjs';

const motorEnv = {
  MOTOR_LABOR_BASE_URL: 'https://licensed.example.test/api/',
  MOTOR_LABOR_SEARCH_PATH: 'labor/search',
  MOTOR_LABOR_API_KEY: 'motor-secret',
  MOTOR_LABOR_LICENSE_CONFIRMED: 'true',
};

test('reports configured providers without exposing credentials', () => {
  const status = getLaborProviderStatus(motorEnv);
  assert.deepEqual(status.motor, {
    provider: 'MOTOR',
    configured: true,
    credentialsConfigured: true,
    licenseConfirmed: true,
    hasPunchout: false,
    configurationError: null,
  });
  assert.equal(status.alldata.configured, false);
  assert.equal(JSON.stringify(status).includes('motor-secret'), false);
});

test('normalizes bounded labor search input', () => {
  assert.deepEqual(normalizeLaborSearchInput({
    vin: ' 1hgcm82633a004352 ',
    year: '2020',
    make: ' Honda ',
    model: ' Accord ',
    engine: ' 2.0L ',
    query: `brakes${'x'.repeat(600)}`,
  }), {
    vin: '1HGCM82633A004352',
    year: 2020,
    make: 'Honda',
    model: 'Accord',
    engine: '2.0L',
    query: `brakes${'x'.repeat(494)}`,
  });
  assert.throws(() => normalizeLaborSearchInput({ year: 1700 }), /vehicle year/);
  assert.throws(() => normalizeLaborSearchInput({}), /At least one/);
});

test('normalizes successful licensed MOTOR output as verified', async () => {
  let request;
  const results = await searchLicensedLabor(motorEnv, {
    vin: '1HGCM82633A004352',
    query: 'front brake pads',
  }, {
    fetch: async (url, init) => {
      request = { url: url.toString(), init };
      return new Response(JSON.stringify({
        data: {
          results: [
            { laborHours: '1.6', operation: 'Replace front brake pads' },
            { laborHours: -1, operation: 'invalid' },
          ],
        },
      }), { status: 200 });
    },
  });

  assert.equal(request.url, 'https://licensed.example.test/api/labor/search');
  assert.equal(request.init.headers.Authorization, 'Bearer motor-secret');
  assert.deepEqual(JSON.parse(request.init.body), {
    vin: '1HGCM82633A004352',
    year: null,
    make: '',
    model: '',
    engine: '',
    query: 'front brake pads',
  });
  assert.deepEqual(results, [{
    hours: 1.6,
    source: 'MOTOR',
    provider: 'MOTOR',
    verified: true,
    description: 'Replace front brake pads',
  }]);
  assert.equal(JSON.stringify(results).includes('motor-secret'), false);
});

test('supports ALLDATA selection and safely URL-encodes GET search fields', async () => {
  const env = {
    ALLDATA_LABOR_BASE_URL: 'http://localhost:8787/root/',
    ALLDATA_LABOR_SEARCH_PATH: 'lookup',
    ALLDATA_LABOR_TOKEN: 'token',
    ALLDATA_LABOR_SEARCH_METHOD: 'GET',
    ALLDATA_LABOR_LICENSE_CONFIRMED: 'true',
  };
  let requestedUrl;
  const results = await searchLicensedLabor(env, {
    year: 2022,
    make: 'Land Rover',
    query: 'oil & filter',
  }, {
    provider: 'alldata',
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ operations: [{ standardHours: 0.8, source: 'ALLDATA licensed' }] }));
    },
  });

  assert.equal(requestedUrl.searchParams.get('make'), 'Land Rover');
  assert.equal(requestedUrl.searchParams.get('query'), 'oil & filter');
  assert.match(requestedUrl.toString(), /Land\+Rover/);
  assert.equal(results[0].verified, true);
  assert.equal(results[0].provider, 'ALLDATA');
});

test('returns an explicitly unverified fallback when unconfigured or empty', async () => {
  const expected = [{
    hours: null,
    source: 'Unverified shop estimate',
    provider: null,
    verified: false,
  }];
  assert.deepEqual(await searchLicensedLabor({}, { query: 'water pump' }), expected);
  let fetched = false;
  assert.deepEqual(await searchLicensedLabor({
    ...motorEnv,
    MOTOR_LABOR_LICENSE_CONFIRMED: 'false',
  }, { query: 'water pump' }, {
    fetch: async () => {
      fetched = true;
      return new Response(JSON.stringify({ results: [{ hours: 2 }] }));
    },
  }), expected);
  assert.equal(fetched, false);
  assert.deepEqual(await searchLicensedLabor(motorEnv, { query: 'water pump' }, {
    fetch: async () => new Response(JSON.stringify({ results: [] })),
  }), expected);
});

test('rejects insecure configuration and reports meaningful provider errors', async () => {
  await assert.rejects(
    searchLicensedLabor({
      ...motorEnv,
      MOTOR_LABOR_BASE_URL: 'http://vendor.example.test',
    }, { query: 'alternator' }),
    (error) => error instanceof LaborProviderError && /HTTPS/.test(error.message),
  );
  await assert.rejects(
    searchLicensedLabor(motorEnv, { query: 'alternator' }, {
      fetch: async () => new Response('down', { status: 503 }),
    }),
    (error) => error instanceof LaborProviderError
      && error.provider === 'MOTOR'
      && error.status === 503,
  );
});
