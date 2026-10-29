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
  assert.deepEqual(matches.map(match => match.service.id), ['svc-cel', 'menu-v6-tuneup', 'menu-coolant', 'svc-evap'], 'no menu service fits an ABS wheel-speed code, so none is guessed');
  assert.equal(matches[0].reason, 'Diagnosis');
  assert.deepEqual(matches.find(match => match.reason === 'Misfire / ignition').codes, ['P0302', 'P0304']);
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
  const menu = buildScanEstimateLines({ codes: ['P0301'], services: CANNED_MENU, laborRate: 150 }).lines.find(line => line.cannedServiceId === 'menu-v6-tuneup');
  assert.equal(menu.type, 'fee');
  assert.ok(menu.total > 0);
});
