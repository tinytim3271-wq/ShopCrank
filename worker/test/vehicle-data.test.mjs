import test from 'node:test';
import assert from 'node:assert/strict';
import { carfaxServiceHistory, decodeVinNhtsa, lookupPlate, normalizeServiceRecord, vehicleDataStatus } from '../src/integrations/vehicle-data.mjs';

const VIN = '1FTFW1E50NFA00001';
const nhtsa = { Results: [{ ModelYear: '2022', Make: 'FORD', Model: 'F-150', Trim: 'XLT', DisplacementL: '5.0', EngineCylinders: '8', FuelTypePrimary: 'Gasoline' }] };

test('lookups fail closed with a clear message until credentials are configured', async () => {
  assert.deepEqual(vehicleDataStatus({}), { plateToVin: false, carfax: false, vinDecode: true });
  await assert.rejects(() => lookupPlate({}, { plate: 'ABC123', state: 'TX' }), error => error.status === 501 && /not connected/.test(error.message));
  await assert.rejects(() => carfaxServiceHistory({}, { vin: VIN }), error => error.status === 501 && /CARFAX/.test(error.message));
  await assert.rejects(() => lookupPlate({}, { plate: 'ABC123', state: 'ZZ' }), error => error.status === 400);
});

test('plate lookup posts plate and state, finds the VIN in common shapes, and decodes it with NHTSA', async () => {
  const env = { PLATE_TO_VIN_BASE_URL: 'https://plates.example.test/api', PLATE_TO_VIN_PATH: 'convert', PLATE_TO_VIN_API_KEY: 'k1', PLATE_TO_VIN_AUTH_SCHEME: '' };
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('vpic.nhtsa.dot.gov')) return Response.json(nhtsa);
    return Response.json({ success: true, vin: { vin: VIN.toLowerCase(), year: '2022' } });
  };
  const result = await lookupPlate(env, { plate: 'abc-123', state: 'tx' }, { fetcher });
  assert.equal(calls[0].url, 'https://plates.example.test/api/convert');
  assert.equal(calls[0].init.headers.Authorization, 'k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { plate: 'ABC123', state: 'TX' });
  assert.equal(result.found, true);
  assert.equal(result.vin, VIN);
  assert.equal(result.make, 'FORD');
  assert.equal(result.engine, '5.0L 8-cyl');
});

test('CARFAX history uses the configured path and normalizes records newest first', async () => {
  const env = { CARFAX_BASE_URL: 'https://carfax.example.test', CARFAX_SERVICE_HISTORY_PATH: '/v1/history/{vin}', CARFAX_API_KEY: 'cf', CARFAX_PARTNER_ID: 'p-1' };
  let seen;
  const result = await carfaxServiceHistory(env, { vin: VIN.toLowerCase() }, {
    fetcher: async (url, init) => {
      seen = { url: String(url), headers: init.headers };
      return Response.json({ serviceRecords: [
        { date: '2024-01-10', odometer: '30,100', services: [{ text: 'Oil and filter changed' }], source: 'Quick Lube' },
        { serviceDate: '2025-06-02', mileage: 41234, description: 'Brake pads replaced', facility: 'Dealer' },
        { nothing: true },
      ] });
    },
  });
  assert.equal(seen.url, `https://carfax.example.test/v1/history/${VIN}`);
  assert.equal(seen.headers.Authorization, 'Bearer cf');
  assert.equal(seen.headers['X-Partner-Id'], 'p-1');
  assert.deepEqual(result.records.map(record => record.date), ['2025-06-02', '2024-01-10']);
  assert.equal(result.records[1].odometer, 30100);
  assert.equal(result.records[1].description, 'Oil and filter changed');
  assert.equal(normalizeServiceRecord({}), null);
});

test('NHTSA decode returns the VIN even if vPIC is down', async () => {
  assert.deepEqual(await decodeVinNhtsa(VIN, { fetcher: async () => { throw new Error('down'); } }), { vin: VIN });
});
