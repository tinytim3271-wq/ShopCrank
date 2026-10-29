import test from 'node:test';
import assert from 'node:assert/strict';
import { CANNED_MENU } from './canned-services.js';
import { buildScanEstimateLines, cannedServicesForCodes, scanEstimateSummary } from './scan-to-estimate.js';

const shopServices = [
  ...CANNED_MENU,
  { id: 'svc-cel', name: 'Check Engine Light Diagnosis', laborHours: 1 },
  { id: 'svc-evap', name: 'EVAP Smoke Test', laborHours: 0.8, partsPrice: 0 },
];

test('codes pick matching canned services, with the diagnostic service first', () => {
  const matches = cannedServicesForCodes(['P0302', 'p0304', 'P0455', 'P0128', 'C0035'], shopServices);
  assert.deepEqual(matches.map(match => match.service.id), ['svc-cel', 'menu-coolant', 'svc-evap'], 'no fitment for the V6 tune-up and no menu service for an ABS wheel-speed code, so neither is guessed');
  const v6 = cannedServicesForCodes(['P0302'], shopServices, { vehicle: '2014 Toyota Camry 3.5L 6-cyl' });
  assert.ok(v6.some(match => match.service.id === 'menu-v6-tuneup'));
  const four = cannedServicesForCodes(['P0302'], shopServices, { vehicle: '2019 Honda Civic 2.0L 4-cyl' });
  assert.ok(!four.some(match => match.service.id === 'menu-v6-tuneup'), 'a V6 package is never offered for a four-cylinder');
  assert.equal(matches[0].reason, 'Diagnosis');
  assert.deepEqual(cannedServicesForCodes(['P0302', 'p0304'], shopServices, { vehicle: 'V6' }).find(match => match.reason === 'Misfire / ignition').codes, ['P0302', 'P0304']);
  assert.deepEqual(cannedServicesForCodes([], shopServices), []);
});

test('canned lines use menu prices or hours at the shop rate, then AI lines that are not duplicates', () => {
  const { lines, matches } = buildScanEstimateLines({
    codes: ['P0455'],
    services: shopServices,
    laborRate: 150,
    scanId: 'scan-1',
    aiLines: [
      { id: 'ai-1', type: 'labor', description: 'EVAP smoke test', hours: 1, laborRate: 150 },
      { id: 'ai-2', type: 'part', description: 'Purge valve', quantity: 1, unitPrice: 0, priceStatus: 'pending' },
    ],
  });
  assert.deepEqual(lines.map(line => line.description), ['Check Engine Light Diagnosis', 'EVAP Smoke Test', 'Purge valve']);
  assert.equal(lines[0].total, 150);
  assert.equal(lines[1].total, 120);
  assert.equal(lines[0].source, 'scan');
  assert.deepEqual(lines[1].dtcCodes, ['P0455']);
  assert.match(scanEstimateSummary({ matches, lines }), /3 lines · canned: Check Engine Light Diagnosis \(P0455\); EVAP Smoke Test \(P0455\)/);
  const menu = buildScanEstimateLines({ codes: ['P0301'], services: CANNED_MENU, laborRate: 150, vehicle: 'V6' }).lines.find(line => line.cannedServiceId === 'menu-v6-tuneup');
  assert.equal(menu.type, 'fee');
  assert.ok(menu.total > 0);
});

test('cylinder counts are read from common spellings', async () => {
  const { cylinderCount } = await import('./scan-to-estimate.js');
  assert.deepEqual(['V6 Tune-Up', 'V-8', 'I4 engine', 'inline-4', '2.5L 4-cyl', '6 cylinder', 'Brake job'].map(cylinderCount), [6, 8, 4, 4, 4, 6, null]);
});

test('review fixes: no-start diagnostics are not a general baseline, and menu discounts apply', () => {
  const evap = buildScanEstimateLines({ codes: ['P0455'], services: CANNED_MENU, laborRate: 150 });
  assert.ok(!evap.lines.some(line => /No-Start/.test(line.description)), 'battery/starter testing is not added to an EVAP estimate');
  const discounted = buildScanEstimateLines({ codes: ['P0455'], laborRate: 150, services: [
    { id: 'cel', name: 'Check Engine Light Diagnosis', menuPrice: 100, discount: 10 },
    { id: 'evap', name: 'EVAP Smoke Test', laborHours: 1, partsPrice: 20, discount: 10 },
  ] }).lines;
  assert.deepEqual(discounted.map(line => line.total), [90, 135, 18]);
  assert.match(discounted[0].notes, /10% menu discount/);
});
