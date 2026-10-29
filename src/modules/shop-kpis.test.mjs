import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShopKpis, kpiDashboardHtml, periodRange } from './shop-kpis.js';

const users = [
  { id: 'tech-1', name: 'Terry Tech', role: 'technician', payRate: 30, employmentType: 'Hourly' },
  { id: 'tech-2', name: 'Sam Salary', role: 'technician', payRate: 62400, employmentType: 'Salary' },
];
const orders = [
  { id: 'RO-1', vin: 'VIN1', assignments: [{ employeeId: 'tech-1' }] },
  { id: 'RO-2', vin: 'VIN1' },
  { id: 'RO-3', vin: 'VIN2' },
];
const invoices = [
  { number: 'INV-1', ro: 'RO-1', date: '2026-10-05', status: 'paid', subtotal: 400, amount: 420, tax: 20, lines: [
    { type: 'labor', hours: 2, laborRate: 150, total: 300, technicianIds: ['tech-1'] },
    { type: 'part', quantity: 2, unitPrice: 50, total: 100, partstech: { cost: 30 } },
  ] },
  { number: 'INV-2', ro: 'RO-2', date: '2026-10-12', status: 'sent', subtotal: 200, amount: 210, tax: 10, lines: [
    { type: 'labor', hours: 1, laborRate: 100, total: 100, technicianIds: ['tech-1', 'tech-2'] },
    { type: 'part', quantity: 1, unitPrice: 100, total: 100, inventorySku: 'PAD-1' },
    { type: 'labor', hours: 3, laborRate: 100, total: 300, approvalStatus: 'declined' },
  ] },
  { number: 'INV-3', ro: 'RO-3', date: '2026-10-20', status: 'void', subtotal: 999, lines: [] },
  { number: 'INV-4', ro: 'RO-3', date: '2026-09-30', status: 'paid', subtotal: 500, lines: [] },
];
const jobClockEntries = [
  { userId: 'tech-1', workOrderId: 'RO-1', clockIn: '2026-10-05T14:00:00Z', hours: 1.5 },
  { userId: 'tech-1', workOrderId: 'RO-2', clockIn: '2026-10-12T14:00:00Z', hours: 0.5 },
  { userId: 'tech-2', workOrderId: 'RO-2', clockIn: '2026-10-12T15:00:00Z', hours: 1 },
];
const shiftEntries = [
  { userId: 'tech-1', clockIn: '2026-10-05T13:00:00Z', hours: 4 },
  { userId: 'tech-2', clockIn: '2026-10-12T13:00:00Z', hours: 2 },
];

test('car count, ARO, gross profit, and margins follow the stated definitions', () => {
  const kpis = computeShopKpis({ invoices, orders, jobClockEntries, shiftEntries, users, inventory: [{ sku: 'PAD-1', cost: 40 }], from: '2026-10-01', to: '2026-10-31' });
  assert.equal(kpis.roCount, 2, 'void and out-of-period invoices excluded');
  assert.equal(kpis.carCount, 1, 'two visits by the same VIN are one car');
  assert.equal(kpis.sales, 600);
  assert.equal(kpis.aro, 300);
  assert.equal(kpis.partsSales, 200);
  assert.equal(kpis.partsCost, 100, '2 × $30 PartsTech + 1 × $40 inventory');
  assert.equal(kpis.partsMargin, 50);
  assert.equal(kpis.laborSales, 400, 'declined labor is not sales');
  // 2.0 h × $30 + 1 h × ($62,400 / 2080 = $30)
  assert.equal(kpis.laborCost, 90);
  assert.equal(kpis.grossProfit, 410);
  assert.equal(kpis.grossMargin, 68.3);
  assert.equal(kpis.partsCostCoverage, 100);
  assert.equal(kpis.laborCostCoverage, 100);
});

test('technician efficiency and productivity', () => {
  const { techs } = computeShopKpis({ invoices, orders, jobClockEntries, shiftEntries, users, from: '2026-10-01', to: '2026-10-31' });
  const terry = techs.find(tech => tech.id === 'tech-1');
  assert.equal(terry.billedHours, 2.5, '2 h on RO-1 plus half of the shared 1 h line');
  assert.equal(terry.clockedHours, 2);
  assert.equal(terry.efficiency, 125);
  assert.equal(terry.productivity, 50);
  const sam = techs.find(tech => tech.id === 'tech-2');
  assert.equal(sam.efficiency, 50);
  assert.equal(sam.productivity, 50);
});

test('missing costs are reported instead of silently inflating margin', () => {
  const kpis = computeShopKpis({ invoices, orders, users: [], jobClockEntries, from: '2026-10-01', to: '2026-10-31' });
  assert.equal(kpis.partsCostCoverage, 50, 'inventory cost unknown for PAD-1');
  assert.equal(kpis.laborCostCoverage, 0);
  assert.equal(kpis.laborMargin, null);
  const html = kpiDashboardHtml(kpis);
  assert.match(html, /Parts cost is known for 50% of parts sales/);
  assert.match(html, /Labor cost uses pay rates for 0% of clocked hours/);
  assert.match(html, /Car count/);
  assert.match(html, /Average repair order/);
});

test('period ranges', () => {
  const today = new Date(2026, 9, 29);
  assert.deepEqual(periodRange('month', today), { from: '2026-10-01', to: '2026-10-29', label: 'This month' });
  assert.deepEqual(periodRange('last_month', today), { from: '2026-09-01', to: '2026-09-30', label: 'Last month' });
  assert.equal(periodRange('week', today).from, '2026-10-26');
  assert.equal(periodRange('ytd', today).from, '2026-01-01');
});

test('review fixes: core deposits excluded, placeholder VINs do not merge cars, earlier clock time still costs the job', () => {
  const kpis = computeShopKpis({
    users: [{ id: 't', payRate: 20, role: 'technician' }],
    orders: [{ id: 'RO-A', vin: 'VIN pending', vehicle: 'Civic', customer: 'A' }, { id: 'RO-B', vin: 'VIN pending', vehicle: 'F-150', customer: 'B' }],
    invoices: [
      { number: 'I1', ro: 'RO-A', customer: 'A', vehicle: 'Civic', date: '2026-10-01', subtotal: 150, lines: [
        { type: 'part', quantity: 1, unitPrice: 100, total: 100, partstech: { cost: 40 } },
        { type: 'part', quantity: 1, unitPrice: 50, total: 50, partstech: { cost: 40, isCore: true } },
      ] },
      { number: 'I2', ro: 'RO-B', customer: 'B', vehicle: 'F-150', date: '2026-10-02', subtotal: 100, lines: [{ type: 'labor', hours: 1, laborRate: 100, total: 100, technicianIds: ['t'] }] },
    ],
    jobClockEntries: [{ userId: 't', workOrderId: 'RO-B', clockIn: '2026-09-30T20:00:00Z', hours: 2 }],
    from: '2026-10-01', to: '2026-10-31',
  });
  assert.equal(kpis.carCount, 2);
  assert.equal(kpis.partsSales, 100);
  assert.equal(kpis.partsCost, 40);
  assert.equal(kpis.laborCost, 40, 'September clock time on an October invoice');
  assert.equal(kpis.techs[0].clockedHours, 0, 'but it is not October activity');
});
