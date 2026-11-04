import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterMidnightFeeFingerprint,
  customLaborDraft,
  customersWithSelected,
  estimateEditorDescription,
  invoicePrintLineItems,
  isLegacyAfterMidnightLine,
  terminalOrderChangesAfterMidnightFee,
} from './work-order-editor.js';

test('customer choices retain an order customer missing from the loaded customer list', () => {
  const customers = [{ name: 'Tebria Ingram' }];
  const choices = customersWithSelected(customers, 'Isaac Gallardo');

  assert.deepEqual(choices.map(customer => customer.name), ['Isaac Gallardo', 'Tebria Ingram']);
  assert.deepEqual(customers, [{ name: 'Tebria Ingram' }]);
  assert.equal(customersWithSelected(choices, 'Isaac Gallardo').length, 2);
});

test('customer choices omit archived customers except for the selected historical customer', () => {
  const archived = { id: 'customer-archived', name: 'Isaac Gallardo', archivedAt: '2026-10-01T00:00:00.000Z' };
  const customers = [archived, { id: 'customer-active', name: 'Tebria Ingram' }];

  assert.deepEqual(customersWithSelected(customers).map(customer => customer.id), ['customer-active']);
  assert.deepEqual(customersWithSelected(customers, 'Isaac Gallardo'), [archived, customers[1]]);
});

test('custom labor starts empty with a placeholder and typed text is not prefixed', () => {
  const draft = customLaborDraft('labor-1', 140);
  const initial = estimateEditorDescription(draft, 'Labor');
  const typed = estimateEditorDescription({ ...draft, description: 'Diagnose vibration' }, 'Diagnose vibration');

  assert.deepEqual(initial, { value: '', placeholder: 'Custom labor' });
  assert.deepEqual(typed, { value: 'Diagnose vibration', placeholder: 'Custom labor' });
});

test('legacy after-midnight labor descriptions are normalized and detected', () => {
  assert.equal(isLegacyAfterMidnightLine({
    type: 'labor',
    description: 'After 12:00 am Differentail fee',
    hours: 1,
    laborRate: 140,
  }), true);
  assert.equal(isLegacyAfterMidnightLine({ type: 'labor', description: 'Overnight surcharge' }), true);
  assert.equal(isLegacyAfterMidnightLine({ type: 'labor', description: 'Differential fluid service' }), false);
  assert.equal(isLegacyAfterMidnightLine({ type: 'fee', description: 'Late night fee' }), false);
  assert.equal(isLegacyAfterMidnightLine({ type: 'fee', code: 'after-midnight' }), false);
});

test('terminal orders reject adding or removing the after-midnight preset', () => {
  const preset = [{
    id: 'fee-after-midnight-1',
    code: 'after-midnight',
    description: 'a $200 flat fee for labor performed between midnight and 6 AM, itemized as its own line on the work order.',
    unitPrice: 200,
  }];
  assert.notEqual(afterMidnightFeeFingerprint(preset), afterMidnightFeeFingerprint([]));
  assert.equal(terminalOrderChangesAfterMidnightFee('completed', [], preset), true);
  assert.equal(terminalOrderChangesAfterMidnightFee('invoiced', preset, []), true);
  assert.equal(terminalOrderChangesAfterMidnightFee('in_progress', [], preset), false);
  assert.equal(terminalOrderChangesAfterMidnightFee('invoiced', preset, structuredClone(preset)), false);
});

test('invoice print items include labor, parts, flat fees, and legacy estimate fees', () => {
  const items = invoicePrintLineItems({
    lines: [
      { type: 'labor', description: 'Emergency diagnosis', hours: 1, laborRate: 140, total: 140 },
      { type: 'part', description: 'Relay', quantity: 2, unitPrice: 30, total: 60 },
      { type: 'fee', description: 'After-midnight fee', quantity: 9, unitPrice: 200, total: 200 },
    ],
    fees: [{ description: 'Shop supplies', amount: 4.2 }],
  });

  assert.deepEqual(items, [
    { type: 'labor', description: 'Emergency diagnosis', detail: '1.00 hr × 140.00', amount: 140 },
    { type: 'part', description: 'Relay', detail: '2 × 30.00', amount: 60 },
    { type: 'fee', description: 'After-midnight fee', detail: 'Flat fee', amount: 200 },
    { type: 'fee', description: 'Shop supplies', detail: 'Fee', amount: 4.2 },
  ]);
});
