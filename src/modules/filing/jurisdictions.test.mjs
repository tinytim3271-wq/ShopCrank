import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TX_JURISDICTIONS,
  buildJurisdictionSupplement,
  combinedSalesTaxRate,
  needsLocalJurisdictions,
  normalizeJurisdictions,
} from './jurisdictions.js';

test('a new shop starts with the state line only, not placeholder local districts', () => {
  // "Example City" and friends are not real jurisdictions. Shipping them made
  // the filing report list a district the shop does not owe and inflated the
  // default rate to 8.25%.
  assert.deepEqual(DEFAULT_TX_JURISDICTIONS, [
    { code: '2001000', name: 'State of Texas', kind: 'state', rate: 6.25, required: true },
  ]);
  for (const jurisdiction of DEFAULT_TX_JURISDICTIONS) {
    assert.doesNotMatch(jurisdiction.name, /Example/i);
    assert.doesNotMatch(jurisdiction.code, /1598/);
  }
});

test('the default jurisdiction rate is the state rate, not 8.25', () => {
  assert.equal(combinedSalesTaxRate(DEFAULT_TX_JURISDICTIONS), 6.25);
});

test('normalizeJurisdictions falls back to the state line only', () => {
  const normalized = normalizeJurisdictions([]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].kind, 'state');
  assert.equal(combinedSalesTaxRate(normalized), 6.25);
  assert.doesNotMatch(JSON.stringify(normalized), /Example/i);
});

test('needsLocalJurisdictions tells the owner to add their local districts', () => {
  assert.equal(needsLocalJurisdictions(DEFAULT_TX_JURISDICTIONS), true);
  assert.equal(needsLocalJurisdictions([]), true);
  assert.equal(needsLocalJurisdictions(undefined), true);
  assert.equal(needsLocalJurisdictions([
    { code: '2001000', name: 'State of Texas', kind: 'state', rate: 6.25 },
    { code: '2060000', name: 'Lubbock', kind: 'city', rate: 2.0 },
  ]), false);
});

test('a shop that has entered its own districts keeps them', () => {
  const own = [
    { code: '2001000', name: 'State of Texas', kind: 'state', rate: 6.25, required: true },
    { code: '2060000', name: 'Lubbock', kind: 'city', rate: 2.0, required: true },
  ];
  const normalized = normalizeJurisdictions(own);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1].name, 'Lubbock');
  assert.equal(combinedSalesTaxRate(normalized), 8.25);
  assert.equal(needsLocalJurisdictions(normalized), false);
});

test('the filing supplement reports only the jurisdictions the shop actually has', () => {
  const supplement = buildJurisdictionSupplement(1000, DEFAULT_TX_JURISDICTIONS);
  assert.equal(supplement.rows.length, 1);
  assert.equal(supplement.stateTax, 62.5);
  assert.equal(supplement.localTax, 0);
  assert.equal(supplement.totalTax, 62.5);
});
