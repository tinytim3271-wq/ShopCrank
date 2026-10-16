import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPartstechOrderRequest,
  mapPartstechOrderSummary,
  mapPartstechQuoteItemToEstimateLine,
  parsePartstechMoney,
  partstechConnectionStatus,
  partstechLineToEstimateLines,
  partstechPanelHtml,
  partstechPricing,
  partstechQuoteRowHtml,
} from './partstech.js';

test('partstech fails closed when credentials missing', () => {
  assert.equal(partstechConnectionStatus(null).connected, false);
  assert.equal(partstechConnectionStatus({ userId: 'u' }).status, 'not_connected');
  assert.equal(partstechConnectionStatus({
    userId: 'u', userKey: 'uk', partnerId: 'p', partnerKey: 'pk',
  }).connected, true);
});

test('quote items map to estimate part lines', () => {
  const line = mapPartstechQuoteItemToEstimateLine({
    partNumber: 'BP123', brand: 'ACDelco', price: 42.5, quantity: 2, description: 'Brake pad',
  }, 0);
  assert.equal(line.type, 'part');
  assert.equal(line.total, 85);
  assert.equal(line.source, 'partstech');
  assert.equal(line.partNumber, 'BP123');
});

test('nested PartsTech price objects no longer collapse to $0.00', () => {
  const line = mapPartstechQuoteItemToEstimateLine({
    partId: 'pt-991',
    partNumber: 'D1092',
    brand: { id: 'b1', name: 'Wagner', lineCardId: 411 },
    partName: 'ThermoQuiet Ceramic Brake Pads',
    price: { list: 68.99, cost: 34.1, core: 0 },
    availability: [{ name: 'Main', quantity: 4 }, { name: 'DC', quantity: 12 }],
    quantity: 1,
  }, 0);
  assert.equal(line.unitPrice, 68.99);
  assert.equal(line.total, 68.99);
  assert.equal(line.priceStatus, 'priced');
  assert.equal(line.description, 'Wagner ThermoQuiet Ceramic Brake Pads');
  assert.doesNotMatch(line.description, /object Object/);
  assert.equal(line.partstech.cost, 34.1);
  assert.equal(line.partstech.lineCardId, 411);
  assert.equal(line.partstech.availability.quantity, 16);
  assert.equal(line.partstech.priceBasis, 'list');
});

test('cost-only quotes apply the shop markup and unpriced quotes are flagged, not $0', () => {
  assert.deepEqual(partstechPricing({ price: { cost: '$40.00' } }, { markupPercent: 50 }), {
    unitPrice: 60, cost: 40, core: null, priceBasis: 'cost_markup', priceStatus: 'priced',
  });
  const unpriced = mapPartstechQuoteItemToEstimateLine({ partNumber: 'X1', price: { list: null } });
  assert.equal(unpriced.priceStatus, 'pending');
  const row = partstechQuoteRowHtml(unpriced);
  assert.match(row, /Price unavailable/);
  assert.doesNotMatch(row, /\$0\.00/);
  assert.equal(parsePartstechMoney('$1,042.50'), 1042.5);
  assert.equal(parsePartstechMoney({ amount: '12.10' }), 12.1);
  assert.equal(parsePartstechMoney('n/a'), null);
});

test('core charges become their own RO line', () => {
  const line = mapPartstechQuoteItemToEstimateLine({ partNumber: 'ALT-1', price: { list: 220, core: 45 }, quantity: 1 });
  const lines = partstechLineToEstimateLines(line);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].unitPrice, 45);
  assert.match(lines[1].description, /Core charge/);
  assert.equal(lines[1].partstech.isCore, true);
});

test('order request sends only vendor fields from RO part lines', () => {
  const quoted = mapPartstechQuoteItemToEstimateLine({
    partId: 'pt-991', partNumber: 'D1092', brand: { name: 'Wagner', lineCardId: 411 }, partTypeId: 1684, price: { list: 68.99, core: 10 },
  });
  const [part, core] = partstechLineToEstimateLines(quoted);
  const request = buildPartstechOrderRequest({
    storeId: ' 77 ',
    vin: '1c6srfht0ln123456',
    poNumber: 'RO-1050',
    lines: [
      { ...part, quantity: 2, technicianIds: ['t1'], total: 137.98 },
      core,
      { type: 'labor', description: 'Labor', hours: 1 },
      { ...part, id: 'declined', approvalStatus: 'declined' },
    ],
  });
  assert.deepEqual(request, {
    storeId: '77',
    parts: [{ partNumber: 'D1092', quantity: 2, brand: 'Wagner', lineCardId: 411, partTypeId: 1684, partId: 'pt-991' }],
    searchParams: { vin: '1C6SRFHT0LN123456' },
    poNumber: 'RO-1050',
  });
  assert.equal(JSON.stringify(request).includes('undefined'), false);
});

test('order request rejects malformed carts', () => {
  assert.throws(() => buildPartstechOrderRequest({ lines: [{ partNumber: 'A1' }] }), /storeId/);
  assert.throws(() => buildPartstechOrderRequest({ storeId: '1', lines: [] }), /at least one/);
  assert.throws(() => buildPartstechOrderRequest({ storeId: '1', lines: [{ type: 'part', description: 'Mystery' }] }), /part number/);
  assert.throws(() => buildPartstechOrderRequest({ storeId: '1', lines: [{ partNumber: 'A1', quantity: 0 }] }), /whole number/);
  assert.throws(() => buildPartstechOrderRequest({ storeId: '1', lines: [{ partNumber: 'A1' }], callbackUrl: 'http://x.test/cb' }), /HTTPS/);
});

test('order status summaries read nested PartsTech orders', () => {
  const summary = mapPartstechOrderSummary({ orders: [{ id: 'PO-55', status: 'confirmed', total: { amount: '137.98' } }] });
  assert.equal(summary.orderId, 'PO-55');
  assert.equal(summary.status, 'confirmed');
  assert.equal(summary.total, 137.98);
});

test('panel shows not connected without inventing results', () => {
  const html = partstechPanelHtml({}, { escapeHtml: v => String(v ?? ''), icon: () => '' });
  assert.match(html, /not connected/i);
  assert.match(html, /disabled/);
});
