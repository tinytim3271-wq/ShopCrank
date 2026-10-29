import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPartsMatrix, editorCarryFields, laborRateFor, marginWarnings, marginWarningsHtml, matrixPartPrice,
  matrixText, parseMatrixText, pricingRecordFromForm, pricingSettings, pricingSettingsHtml,
} from './pricing-matrix.js';

test('parts matrix: cheaper parts carry a higher multiplier', () => {
  const settings = pricingSettings();
  assert.equal(matrixPartPrice(8, settings), 20);
  assert.equal(matrixPartPrice(40, settings), 80);
  assert.equal(matrixPartPrice(400, settings), 580);
  assert.equal(matrixPartPrice(5000, settings), 6250);
  assert.equal(matrixPartPrice(0, settings), null);
});

test('new part lines are priced from cost; supplier list prices are kept', () => {
  const lines = applyPartsMatrix([
    { id: 'a', type: 'part', quantity: 2, unitPrice: 0, partstech: { cost: 40, priceBasis: 'none' } },
    { id: 'b', type: 'part', quantity: 1, unitPrice: 46, partstech: { cost: 40, priceBasis: 'cost_markup' } },
    { id: 'c', type: 'part', quantity: 1, unitPrice: 95, partstech: { cost: 40, priceBasis: 'list' } },
    { id: 'd', type: 'part', quantity: 1, unitPrice: 0, inventorySku: 'PAD-1' },
    { id: 'e', type: 'labor', hours: 1, laborRate: 150 },
  ], pricingSettings(), [{ sku: 'pad-1', cost: 20 }]);
  assert.deepEqual(lines.map(line => line.unitPrice), [80, 80, 95, 45, undefined]);
  assert.equal(lines[0].total, 160);
  assert.equal(lines[0].priceSource, 'matrix');
  assert.equal(applyPartsMatrix([{ type: 'part', unitPrice: 0, cost: 10 }], pricingSettings({ enabled: false }))[0].unitPrice, 0);
});

test('margin protection flags parts sold below the minimum margin', () => {
  const warnings = marginWarnings([
    { id: 'a', type: 'part', description: 'Rotor', unitPrice: 50, cost: 40 },
    { id: 'b', type: 'part', description: 'Pads', unitPrice: 80, cost: 40 },
    { id: 'c', type: 'part', description: 'Declined', unitPrice: 41, cost: 40, approvalStatus: 'declined' },
  ], pricingSettings({ minPartsMarginPercent: 35 }));
  assert.deepEqual(warnings.map(item => [item.lineId, item.margin, item.suggestedPrice]), [['a', 20, 80]]);
  assert.match(marginWarningsHtml(warnings), /20% margin at \$50\.00 \(cost \$40\.00\)\. Matrix price \$80\.00/);
  assert.equal(marginWarningsHtml([]), '');
});

test('matrix text round-trips and the settings form saves labor rates by category', () => {
  const tiers = parseMatrixText('up to 20: 2.2\nup to $100 = 1.7x\nover: 1.3\nnonsense');
  assert.deepEqual(tiers, [{ upTo: 20, multiplier: 2.2 }, { upTo: 100, multiplier: 1.7 }, { upTo: null, multiplier: 1.3 }]);
  assert.deepEqual(parseMatrixText(matrixText(tiers)), tiers);
  assert.equal(parseMatrixText('up to 50: 2').at(-1).upTo, null, 'a top tier is always present');
  const record = pricingRecordFromForm({ matrixEnabled: 'on', partsMatrix: 'up to 50: 2\nover: 1.4', minPartsMarginPercent: '40', laborRate_diagnostic: '175', laborRate_standard: '' });
  assert.equal(record.minPartsMarginPercent, 40);
  assert.equal(laborRateFor('diagnostic', pricingSettings(record), 140), 175);
  assert.equal(laborRateFor('standard', pricingSettings(record), 140), 140, 'blank falls back to the shop rate');
  assert.doesNotMatch(pricingSettingsHtml({}, { canSave: true }), /name="(name|title|method|body|role)"/);
});

test('the editor carries cost, PartsTech, labor-guide and inspection fields across saves', () => {
  assert.deepEqual(editorCarryFields({ id: 'x', cost: 12, partstech: { cost: 12 }, laborGuide: { bookTime: true }, inspectionStatus: 'critical', photoKeys: ['k'], description: 'd', approvalStatus: 'approved' }), {
    cost: 12, partstech: { cost: 12 }, laborGuide: { bookTime: true }, inspectionStatus: 'critical', photoKeys: ['k'],
  });
});

test('labor category rates apply to lines at the shop default rate only', async () => {
  const { applyLaborMatrix, laborCategoryFor } = await import('./pricing-matrix.js');
  const settings = pricingSettings({ laborRates: { diagnostic: 175, heavy: 160 } });
  const lines = applyLaborMatrix([
    { id: 'a', type: 'labor', description: 'Diagnose check engine light', hours: 1, laborRate: 140 },
    { id: 'b', type: 'labor', description: 'Replace timing chain', hours: 6, laborRate: 0 },
    { id: 'c', type: 'labor', description: 'Diagnose noise', hours: 1, laborRate: 120 },
    { id: 'd', type: 'labor', description: 'Brake pads', hours: 1, laborRate: 140 },
  ], settings, 140);
  assert.deepEqual(lines.map(line => line.laborRate), [175, 160, 120, 140]);
  assert.equal(lines[1].total, 960);
  assert.equal(laborCategoryFor({ description: 'Replace alternator' }), 'electrical');
});
