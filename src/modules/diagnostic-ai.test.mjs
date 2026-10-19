import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnosticAiMessage,
  diagnosticDraftToOrderLines,
  dtcScope,
  estimateDraftAction,
  normalizeDtcs,
} from './diagnostic-ai.js';

test('DTCs are validated, deduplicated, and classified', () => {
  const { dtcs, invalid } = normalizeDtcs('P0300, p0171 P0300 U0100 P1E00 B1A2B XYZ P0');
  assert.deepEqual(dtcs.map(item => [item.code, item.system, item.scope]), [
    ['P0300', 'Powertrain', 'generic (SAE)'],
    ['P0171', 'Powertrain', 'generic (SAE)'],
    ['U0100', 'Network/communication', 'generic (SAE)'],
    ['P1E00', 'Powertrain', 'manufacturer-specific'],
    ['B1A2B', 'Body', 'manufacturer-specific'],
  ]);
  assert.deepEqual(invalid, ['XYZ', 'P0']);
  assert.equal(dtcScope('P3400'), 'generic (SAE)');
  assert.equal(dtcScope('P3000'), 'manufacturer-specific');
});

test('pending and permanent states merge onto one code', () => {
  const { dtcs } = normalizeDtcs([{ code: 'P0420', description: 'Stored' }, { code: 'P0420', description: 'Permanent' }]);
  assert.deepEqual(dtcs[0].states, ['stored', 'permanent']);
});

test('the prompt stays within the assistant limit even with long live data', () => {
  const { dtcs } = normalizeDtcs(Array.from({ length: 40 }, (_, index) => `P0${String(100 + index)}`));
  const readings = Array.from({ length: 50 }, (_, index) => ({ name: `PID ${index} ${'x'.repeat(40)}`, value: 'y'.repeat(30), unit: 'kPa' }));
  const message = buildDiagnosticAiMessage({ order: { id: 'RO-1', vehicle: 'Truck', complaint: 'z'.repeat(2000) }, dtcs, readings });
  assert.ok(message.length <= 3900);
  assert.match(message, /prepare_estimate_work_order/);
});

test('AI drafts become RO lines with unpriced parts and labeled labor hours', () => {
  const action = estimateDraftAction({ actions: [{ kind: 'other' }, { kind: 'estimate_work_order_draft', draft: {
    labor: [{ description: 'Misfire diagnosis', hours: 1.2 }, { description: 'Replace coil', hours: 99 }],
    parts: [{ description: 'Ignition coil', quantity: 1, unitPrice: 85, partNumber: 'UF-414' }],
  } }] });
  const lines = diagnosticDraftToOrderLines(action, { laborRate: 140, scanId: 'scan-1', codes: ['P0303'] });
  assert.deepEqual(lines.map(line => [line.type, line.description, line.hours ?? null, line.unitPrice ?? null]), [
    ['labor', 'Misfire diagnosis', 1.2, null],
    ['labor', 'Replace coil', 40, null],
    ['part', 'Ignition coil', null, 0],
  ]);
  assert.equal(lines[2].priceStatus, 'pending');
  assert.match(lines[0].laborSource, /AI suggestion from scan \(P0303\); verify against the labor guide/);
  assert.equal(lines[0].laborRate, 140);
  assert.equal(estimateDraftAction({ actions: [] }), null);
});
