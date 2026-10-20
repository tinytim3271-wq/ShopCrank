import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvedEstimate,
  calculateEstimate,
  invoiceRecordForOrder,
  isLineTaxable,
  setDefaultTaxPolicy,
  shopTaxPolicy,
  taxPolicyForStoredEstimate,
} from './estimate-workflow.js';
import { calculateShopEstimate } from './estimate-templates.js';

const lines = [
  { id: 'l1', type: 'labor', description: 'Front brakes', hours: 1.8, laborRate: 140 },
  { id: 'p1', type: 'part', description: 'Pads', quantity: 1, unitPrice: 89.99 },
];
const supplies = [{ description: 'Shop supplies', amount: 7.56 }];
const TEXAS = { laborTaxable: false, feesTaxable: true };

test('default policy keeps the pre-ADR-003 behavior: whole subtotal taxed', () => {
  const totals = calculateEstimate(lines, 8.25, supplies);
  assert.equal(totals.subtotal, 349.55);
  assert.equal(totals.taxableSubtotal, 349.55);
  assert.equal(totals.tax, 28.84);
  assert.deepEqual(totals.taxPolicy, { laborTaxable: true, feesTaxable: true });
});

test('Texas policy taxes parts and supplies, not labor', () => {
  const totals = calculateEstimate(lines, 8.25, supplies, TEXAS);
  assert.equal(totals.subtotal, 349.55);
  assert.equal(totals.taxableSubtotal, 97.55);
  assert.equal(totals.tax, 8.05);
  assert.equal(totals.total, 357.6);
});

test('fees can be untaxed and a line can override the policy', () => {
  const totals = calculateEstimate(
    [...lines, { id: 'p2', type: 'part', description: 'Resale core', quantity: 1, unitPrice: 20, taxable: false }],
    10,
    supplies,
    { laborTaxable: false, feesTaxable: false },
  );
  assert.equal(totals.taxableSubtotal, 89.99);
  assert.equal(totals.tax, 9);
  assert.equal(isLineTaxable({ type: 'labor', taxable: true }, TEXAS), true);
});

test('shopTaxPolicy: unset labor taxability is off in Texas, on elsewhere; saved choices win', () => {
  assert.deepEqual(shopTaxPolicy({ state: 'TX' }), { laborTaxable: false, feesTaxable: true });
  assert.deepEqual(shopTaxPolicy({ state: 'ca' }), { laborTaxable: true, feesTaxable: true });
  assert.deepEqual(shopTaxPolicy({ state: 'TX', laborTaxable: true, feesTaxable: false }), { laborTaxable: true, feesTaxable: false });
});

test('discounts reduce taxable and non-taxable amounts in proportion', () => {
  const totals = calculateShopEstimate(lines, { taxRate: 8.25, laborRate: 140, discountPercent: 10, taxPolicy: TEXAS });
  assert.equal(totals.grossSubtotal, 349.55);
  assert.equal(totals.subtotal, 314.59);
  assert.equal(totals.taxableSubtotal, 87.8);
  assert.equal(totals.tax, 7.24);
});

test('Worker re-pricing on approval keeps the policy stored on the estimate', () => {
  const estimate = { ...calculateEstimate(lines, 8.25, supplies, TEXAS), taxRate: 8.25 };
  const approved = approvedEstimate(estimate, {});
  assert.equal(approved.tax, 8.05);
  assert.deepEqual(approved.taxPolicy, TEXAS);
});

test('invoices carry the taxable subtotal and per-line taxable flags for QuickBooks and filing', () => {
  const order = { id: 'RO-1', customer: 'Maria', estimate: { ...calculateEstimate(lines, 8.25, supplies, TEXAS), taxRate: 8.25 } };
  const invoice = invoiceRecordForOrder(order, new Date('2026-10-20T12:00:00Z'));
  assert.equal(invoice.taxableSubtotal, 97.55);
  assert.equal(invoice.tax, 8.05);
  assert.deepEqual(invoice.lines.map(line => [line.type, line.taxable]), [['labor', false], ['part', true]]);
});

test('the browser can supply the shop default as a function; stored policies still win', () => {
  let shop = { state: 'TX' };
  setDefaultTaxPolicy(() => shopTaxPolicy(shop));
  try {
    assert.equal(calculateEstimate(lines, 8.25).taxableSubtotal, 89.99);
    shop = { state: 'TX', laborTaxable: true };
    assert.equal(calculateEstimate(lines, 8.25).taxableSubtotal, 341.99);
    assert.equal(calculateEstimate(lines, 8.25, [], { laborTaxable: false }).taxableSubtotal, 89.99);
  } finally {
    setDefaultTaxPolicy(null);
  }
});

test('saved-estimate recalculation preserves policy and uses legacy policy when absent', () => {
  setDefaultTaxPolicy(() => TEXAS);
  try {
    const saved = calculateShopEstimate(lines, {
      taxRate: 8.25,
      shopSupplies: 7.56,
      taxPolicy: taxPolicyForStoredEstimate({ taxPolicy: TEXAS }),
    });
    const legacy = calculateShopEstimate(lines, {
      taxRate: 8.25,
      shopSupplies: 7.56,
      taxPolicy: taxPolicyForStoredEstimate({}),
    });

    assert.equal(saved.taxableSubtotal, 97.55);
    assert.equal(saved.tax, 8.05);
    assert.equal(legacy.taxableSubtotal, 349.55);
    assert.equal(legacy.tax, 28.84);
  } finally {
    setDefaultTaxPolicy(null);
  }
});
