import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AFTER_MIDNIGHT_FEE_PRESET,
  afterMidnightFeeLine,
  approvedEstimate,
  billableEstimateLines,
  calculateEstimate,
  declinedEstimate,
  estimatePartPriceStatus,
  invoiceRecordForOrder,
  invoiceWithEditedWorkOrder,
  laborLinePrintRows,
  normalizeEstimateLine,
  normalizeTechnicianIds,
  orderHasTechnician,
  workOrderWithEditedEstimate,
} from './estimate-workflow.js';

test('after-midnight preset is a fixed itemized $200 fee line', () => {
  const line = afterMidnightFeeLine('fee-night-1');
  const estimate = calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Emergency repair', hours: 1, laborRate: 140 },
    line,
  ], 8.25);

  assert.equal(AFTER_MIDNIGHT_FEE_PRESET.description, 'a $200 flat fee for labor performed between midnight and 6 AM, itemized as its own line on the work order.');
  assert.equal(line.type, 'fee');
  assert.equal(estimate.lines[1].id, 'fee-night-1');
  assert.equal(estimate.lines[1].quantity, 1);
  assert.equal(estimate.lines[1].unitPrice, 200);
  assert.equal(estimate.lines[1].total, 200);
  assert.equal(estimate.labor, 140);
  assert.equal(estimate.parts, 0);
  assert.equal(estimate.lineFees, 200);
  assert.equal(estimate.subtotal, 340);
  assert.equal(estimate.tax, 28.05);
  assert.equal(estimate.total, 368.05);
  assert.equal(normalizeEstimateLine({ type: 'fee', quantity: 2, unitPrice: 200 }).total, 200);
});

test('after-midnight fee follows line approval and carries into the invoice', () => {
  const estimate = calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Emergency repair', hours: 1, laborRate: 140 },
    afterMidnightFeeLine(),
  ], 8.25);
  const approved = approvedEstimate(estimate, {
    labor: 'approved',
    'fee-after-midnight': 'approved',
  });
  const invoice = invoiceRecordForOrder({
    id: 'RO-1057',
    customer: 'Customer',
    vehicle: 'Vehicle',
    estimate: approved,
  }, new Date('2026-10-07T06:00:00.000Z'));

  assert.equal(approved.lines.find(line => line.type === 'fee').total, 200);
  assert.equal(invoice.lines.find(line => line.type === 'fee').total, 200);
  assert.equal(invoice.amount, 368.05);
});

test('estimate keeps labor and typed or inventory parts on one card', () => {
  const estimate = calculateEstimate([
    { id: 'labor-1', type: 'labor', description: 'Brake service', hours: 2, laborRate: 165 },
    { id: 'part-1', type: 'part', description: 'Brake rotor', quantity: 2, unitPrice: 95, inventoryId: 'rotor', inventorySku: 'BR-10' },
    { id: 'part-2', type: 'part', description: 'Shop supplied hardware', quantity: 1, unitPrice: 18 },
  ], 8.25, [{ description: 'Shop supplies', amount: 12 }]);

  assert.equal(estimate.labor, 330);
  assert.equal(estimate.parts, 208);
  assert.equal(estimate.subtotal, 550);
  assert.equal(estimate.tax, 45.38);
  assert.equal(estimate.total, 595.38);
  assert.equal(estimate.lines[1].inventorySku, 'BR-10');
});

test('customer decisions retain declined lines while totaling approved work only', () => {
  const estimate = calculateEstimate([
    { id: 'recommended', type: 'labor', description: 'Recommended repair', hours: 1, laborRate: 165 },
    { id: 'part', type: 'part', description: 'Optional part', quantity: 1, unitPrice: 80 },
  ], 8.25);
  const approved = approvedEstimate(estimate, { recommended: 'approved', part: 'declined' });

  assert.equal(approved.approvedLineCount, 1);
  assert.equal(approved.declinedLineCount, 1);
  assert.equal(approved.lines[1].approvalStatus, 'declined');
  assert.equal(approved.subtotal, 165);
  assert.equal(approved.total, 178.61);
});

test('flat fee lines survive approval decisions and contribute to totals without labor hours', () => {
  const estimate = calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 140 },
    { id: 'after-midnight', type: 'fee', description: 'After-midnight service', amount: 200 },
  ], 8.25);
  assert.equal(estimate.lineFees, 200);
  assert.equal(estimate.laborHours, 1);
  assert.equal(estimate.subtotal, 340);
  assert.equal(estimate.total, 368.05);

  const approved = approvedEstimate(estimate, {
    labor: 'declined',
    'after-midnight': 'approved',
  });
  assert.equal(approved.lines.find(line => line.id === 'after-midnight').type, 'fee');
  assert.equal(approved.lines.find(line => line.id === 'after-midnight').approvalStatus, 'approved');
  assert.equal(approved.labor, 0);
  assert.equal(approved.laborHours, 0);
  assert.equal(approved.lineFees, 200);
  assert.equal(approved.total, 216.5);
});

test('estimate approval recalculates supplies and discount for approved work and invoice', () => {
  const estimate = {
    ...calculateEstimate([
      { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 140 },
      { id: 'part', type: 'part', description: 'Optional sensor', quantity: 1, unitPrice: 100 },
    ], 8.25, [{ description: 'Shop supplies', amount: 20 }]),
    discountPercent: 10,
    discountReason: 'Customer discount',
  };
  const approved = approvedEstimate(estimate, { labor: 'approved', part: 'declined' });

  assert.deepEqual(approved.fees, [{ description: 'Shop supplies', amount: 4.2 }]);
  assert.equal(approved.grossSubtotal, 144.2);
  assert.equal(approved.discountAmount, 14.42);
  assert.equal(approved.subtotal, 129.78);
  assert.equal(approved.tax, 10.71);
  assert.equal(approved.total, 140.49);

  const invoice = invoiceRecordForOrder({
    id: 'RO-1101',
    customer: 'Customer',
    vehicle: 'Vehicle',
    total: approved.total,
    estimate: approved,
  }, new Date('2026-10-02T12:00:00.000Z'));
  assert.equal(invoice.amount, approved.total);
  assert.equal(invoice.discountAmount, 14.42);
  assert.equal(invoice.subtotal + invoice.tax, invoice.amount);
  assert.equal(invoice.lines.length, 1);
});

test('invoice carries approved estimate lines and signature provenance forward', () => {
  const estimate = approvedEstimate(calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 },
    { id: 'declined', type: 'part', description: 'Optional filter', quantity: 1, unitPrice: 35 },
  ], 8.25), { labor: 'approved', declined: 'declined' });
  const issuedAt = new Date('2026-10-02T12:00:00.000Z');
  const invoice = invoiceRecordForOrder({
    id: 'RO-1100',
    customer: 'Customer',
    vehicle: '2020 Example',
    total: estimate.total,
    estimate,
    estimateApproval: { status: 'approved', signedAt: issuedAt.toISOString() },
  }, issuedAt);

  assert.equal(invoice.number, 'INV-1100');
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].description, 'Diagnosis');
  assert.equal(invoice.amount, estimate.total);
  assert.equal(invoice.subtotal, estimate.subtotal);
  assert.equal(invoice.tax, estimate.tax);
  assert.equal(invoice.sourceEstimateApproval.status, 'approved');
  assert.equal(invoice.due, '2026-10-16');
});

test('invoice money ignores declined lines even when estimate totals were recomputed from the full card', () => {
  const approved = approvedEstimate(calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 },
    { id: 'part', type: 'part', description: 'Optional sensor', quantity: 1, unitPrice: 100 },
  ], 8.25), { labor: 'approved', part: 'declined' });
  // Simulate coherentOrderEstimate / openOrder which recalculates from all lines.
  const inflated = calculateEstimate(approved.lines, approved.taxRate, approved.fees);
  assert.equal(inflated.lines.length, 2);
  assert.equal(inflated.subtotal, approved.subtotal);
  assert.equal(inflated.tax, approved.tax);
  assert.equal(inflated.total, approved.total);

  const invoice = invoiceRecordForOrder({
    id: 'RO-1100',
    customer: 'Customer',
    vehicle: '2020 Example',
    total: approved.total,
    estimate: inflated,
  }, new Date('2026-10-02T12:00:00.000Z'));

  assert.equal(invoice.amount, 178.61);
  assert.equal(invoice.subtotal, 165);
  assert.equal(invoice.tax, 13.61);
  assert.equal(invoice.lines.length, 1);
  assert.equal(roundMoneySafe(invoice.subtotal + invoice.tax), invoice.amount);
});

function roundMoneySafe(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

test('billableEstimateLines drops declined inventory commitments', () => {
  const lines = [
    { id: 'keep', approvalStatus: 'approved', committedQuantity: 2, inventoryId: 'pad' },
    { id: 'skip', approvalStatus: 'declined', committedQuantity: 4, inventoryId: 'rotor' },
    { id: 'pending', approvalStatus: 'pending', committedQuantity: 1, inventoryId: 'fluid' },
  ];
  assert.deepEqual(billableEstimateLines(lines).map(line => line.id), ['keep', 'pending']);
});

test('full-card decline marks every line declined and zeros money including fees', () => {
  const estimate = calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 165 },
    { id: 'part', type: 'part', description: 'Sensor', quantity: 1, unitPrice: 100 },
  ], 8.25, [{ description: 'Shop supplies', amount: 12 }]);
  const { estimate: declined, decisions } = declinedEstimate(estimate);

  assert.equal(declined.approvedLineCount, 0);
  assert.equal(declined.declinedLineCount, 2);
  assert.ok(declined.lines.every(line => line.approvalStatus === 'declined'));
  assert.equal(declined.total, 0);
  assert.equal(declined.subtotal, 0);
  assert.equal(declined.tax, 0);
  assert.equal(declined.fees[0].amount, 12);
  assert.deepEqual(decisions, { labor: 'declined', part: 'declined' });

  const invoice = invoiceRecordForOrder({
    id: 'RO-1100',
    customer: 'Customer',
    vehicle: '2020 Example',
    total: declined.total,
    estimate: declined,
    estimateApproval: { status: 'declined' },
  }, new Date('2026-10-02T12:00:00.000Z'));
  assert.equal(invoice.amount, 0);
  assert.equal(invoice.lines.length, 0);
});

test('line normalization uses quantity pricing for parts', () => {
  const line = normalizeEstimateLine({ type: 'part', description: 'Battery', partNumber: 'BAT-48', quantity: 2, unitPrice: 123.45 });
  assert.equal(line.total, 246.9);
  assert.equal(line.hours, 0);
  assert.equal(line.partNumber, 'BAT-48');
  assert.equal(normalizeEstimateLine({ type: 'labor', hours: 1, laborRate: 0 }).laborRate, 0);
});

test('a pending part becomes priced when a positive price is entered', () => {
  assert.equal(estimatePartPriceStatus('pending', 0), 'pending');
  assert.equal(estimatePartPriceStatus('pending', 12.5), 'priced');
  assert.equal(estimatePartPriceStatus('priced', 0), 'priced');
});

test('editing approved work order lines recalculates totals and requires renewed approval', () => {
  const revisedAt = '2026-10-06T04:00:00.000Z';
  const revised = workOrderWithEditedEstimate({
    id: 'RO-1056',
    customer: 'Isaac Gallardo',
    status: 'in_progress',
    linesLockedAt: '2026-10-05T12:00:00.000Z',
    estimateApproval: { status: 'approved', signedAt: '2026-10-05T12:00:00.000Z' },
  }, {
    taxRate: 8.25,
    fees: [{ description: 'Shop supplies', amount: 12 }],
    lines: [
      { id: 'labor', type: 'labor', description: 'Diagnosis', hours: 2, laborRate: 140 },
      { id: 'maf', type: 'part', description: 'MAF sensor', partNumber: 'MAF-1056', quantity: 1, unitPrice: 175 },
    ],
  }, revisedAt);

  assert.equal(revised.labor, 280);
  assert.equal(revised.customer, 'Isaac Gallardo');
  assert.equal(revised.parts, 175);
  assert.equal(revised.total, 505.53);
  assert.equal(revised.estimate.lines[1].partNumber, 'MAF-1056');
  assert.equal(revised.estimateApproval, null);
  assert.equal(revised.linesLockedAt, null);
  assert.equal(revised.estimateRevisionPending, true);
  assert.equal(revised.status, 'in_progress');
});

test('editing line items preserves every non-estimate work-order identity field', () => {
  const identity = {
    id: 'RO-1057',
    customer: 'Isaac Gallardo',
    customerId: 'customer-isaac',
    phone: '555-0107',
    email: 'isaac@example.test',
    vehicle: '2021 Ford F-150',
    vehicleId: 'vehicle-1057',
    vin: '1FTFW1E50MFA01057',
    complaint: 'Brake vibration',
    status: 'in_progress',
    priority: 'high',
    tech: 'Alex',
    bay: 'Bay 2',
    mobile: false,
    promise: 'Today, 4:00 PM',
    scheduled: '1:00 PM',
    notes: 'Customer is waiting',
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:00.000Z',
  };
  const original = {
    ...identity,
    labor: 140,
    laborHours: 1,
    parts: 0,
    tax: 11.55,
    total: 151.55,
    estimate: {
      taxRate: 8.25,
      fees: [],
      lines: [{ id: 'labor', type: 'labor', description: 'Diagnosis', hours: 1, laborRate: 140 }],
    },
  };

  const revised = workOrderWithEditedEstimate(original, {
    ...original.estimate,
    lines: [{ id: 'labor', type: 'labor', description: 'Brake diagnosis', hours: 2, laborRate: 140 }],
  }, '2026-10-07T20:00:00.000Z');

  assert.deepEqual(
    Object.fromEntries(Object.keys(identity).map(key => [key, revised[key]])),
    identity,
  );
  assert.equal(revised.customer, 'Isaac Gallardo');
  assert.equal(revised.estimate.lines[0].description, 'Brake diagnosis');
  assert.equal(revised.laborHours, 2);
});

test('editing an invoiced work order synchronizes unpaid invoice lines and totals', () => {
  const order = workOrderWithEditedEstimate({ id: 'RO-1056', status: 'invoiced' }, {
    taxRate: 8.25,
    fees: [],
    lines: [
      { id: 'labor', type: 'labor', description: 'MAF diagnosis', hours: 1, laborRate: 140 },
      { id: 'maf', type: 'part', description: 'MAF sensor', partNumber: 'MAF-1056', quantity: 1, unitPrice: 175 },
    ],
  });
  const invoice = invoiceWithEditedWorkOrder({
    number: 'INV-1056',
    signature: { signedAt: '2026-10-05T12:00:00.000Z' },
  }, order, '2026-10-06T04:00:00.000Z');

  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.lines[1].partNumber, 'MAF-1056');
  assert.equal(invoice.subtotal, 315);
  assert.equal(invoice.tax, 25.99);
  assert.equal(invoice.amount, 340.99);
  assert.equal(invoice.signature, null);
  assert.equal(invoice.revisedAt, '2026-10-06T04:00:00.000Z');
});

test('labor lines normalize none, one, or several technician ids as a unique list', () => {
  assert.deepEqual(normalizeEstimateLine({ type: 'labor' }).technicianIds, []);
  assert.deepEqual(normalizeEstimateLine({ type: 'labor', technicianId: 'tech-1' }).technicianIds, ['tech-1']);
  assert.deepEqual(
    normalizeTechnicianIds({ technicianIds: ['tech-1', 'tech-2', 'tech-1', ''] }),
    ['tech-1', 'tech-2'],
  );
  assert.deepEqual(
    normalizeEstimateLine({ type: 'part', technicianIds: ['tech-1'] }).technicianIds,
    [],
  );
});

test('technicians assigned on labor lines can access the work order', () => {
  const order = {
    tech: 'Legacy technician',
    estimate: { lines: [
      { type: 'labor', technicianIds: ['tech-1', 'tech-2'] },
      { type: 'part', technicianIds: ['tech-3'] },
    ] },
  };

  assert.equal(orderHasTechnician(order, { id: 'tech-1' }), true);
  assert.equal(orderHasTechnician(order, { id: 'tech-2' }), true);
  assert.equal(orderHasTechnician(order, { id: 'tech-3' }), false);
  assert.equal(orderHasTechnician(order, { name: 'Legacy technician' }), true);
  assert.equal(orderHasTechnician(order, { techName: 'Legacy technician' }), true);
  assert.equal(orderHasTechnician(order, { id: 'other' }), false);
  assert.equal(orderHasTechnician({}, {}), false);
});

test('printed job card expands each labor line to one row per technician', () => {
  const rows = laborLinePrintRows([
    { id: 'labor-a', type: 'labor', description: 'Replace fender', hours: 3.7, laborRate: 140, technicianIds: ['tech-1', 'tech-2', 'tech-3'] },
    { id: 'labor-b', type: 'labor', description: 'Aim headlamp', hours: 0.9, laborRate: 140, technicianIds: [] },
    { id: 'part-a', type: 'part', description: 'Fender', quantity: 1, unitPrice: 374.79 },
  ], [
    { id: 'tech-1', name: 'Alex' },
    { id: 'tech-2', name: 'Blair' },
    { id: 'tech-3', name: 'Casey' },
  ]);

  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(0, 3).map(row => row.technicianName), ['Alex', 'Blair', 'Casey']);
  assert.deepEqual(rows.slice(0, 3).map(row => row.line.id), ['labor-a', 'labor-a', 'labor-a']);
  assert.deepEqual(rows.slice(0, 3).map(row => row.lineTotal), [518, null, null]);
  assert.equal(rows[3].line.id, 'labor-b');
  assert.equal(rows[3].technicianName, 'Unassigned');
  assert.equal(rows[3].lineTotal, 126);
});

test('labor technician sets survive estimate calculation and invoice creation', () => {
  const estimate = calculateEstimate([
    { id: 'labor', type: 'labor', description: 'Repair', hours: 2, laborRate: 140, technicianIds: ['tech-1', 'tech-2'] },
  ], 8.25);
  const invoice = invoiceRecordForOrder({
    id: 'RO-1200',
    customer: 'Customer',
    vehicle: 'Vehicle',
    total: estimate.total,
    estimate,
  }, new Date('2026-10-04T12:00:00.000Z'));

  assert.deepEqual(estimate.lines[0].technicianIds, ['tech-1', 'tech-2']);
  assert.deepEqual(invoice.lines[0].technicianIds, ['tech-1', 'tech-2']);
});

test('quoted parts are appended to the repair order estimate with recalculated totals', async () => {
  const { appendEstimateLinesToOrder, ordersAcceptingEstimateLines } = await import('./estimate-workflow.js');
  const order = {
    id: 'RO-1050',
    status: 'estimate',
    estimate: { taxRate: 10, lines: [{ id: 'pt-part-1', type: 'labor', description: 'Brake labor', hours: 1, laborRate: 100 }] },
  };
  const revised = appendEstimateLinesToOrder(order, [
    { id: 'pt-part-1', type: 'part', description: 'Wagner pads', partNumber: 'D1092', quantity: 1, unitPrice: 68.99, source: 'partstech', approvalStatus: 'approved' },
    { id: 'pt-part-1', type: 'part', description: 'Core charge', quantity: 1, unitPrice: 10, source: 'partstech' },
  ], { editedAt: '2026-10-16T12:00:00.000Z' });
  assert.deepEqual(revised.estimate.lines.map(line => line.id), ['pt-part-1', 'pt-part-1-2', 'pt-part-1-3']);
  assert.equal(revised.estimate.lines[1].approvalStatus, 'pending');
  assert.equal(revised.parts, 78.99);
  assert.equal(revised.labor, 100);
  assert.equal(revised.tax, 17.9);
  assert.equal(revised.total, 196.89);
  assert.equal(order.estimate.lines.length, 1);
  assert.throws(() => appendEstimateLinesToOrder({ ...order, status: 'invoiced' }, [{ type: 'part' }]), /reopen/);
  assert.throws(() => appendEstimateLinesToOrder({}, [{ type: 'part' }]), /repair order/);
  assert.deepEqual(ordersAcceptingEstimateLines([order, { id: 'RO-1', status: 'paid' }, { status: 'estimate' }]).map(item => item.id), ['RO-1050']);
});

test('adding lines to an approved order requires re-approval', async () => {
  const { appendEstimateLinesToOrder } = await import('./estimate-workflow.js');
  const revised = appendEstimateLinesToOrder({
    id: 'RO-2', status: 'approved', estimateApproval: { status: 'approved' }, estimate: { lines: [] },
  }, [{ type: 'part', description: 'Rotor', quantity: 1, unitPrice: 50 }]);
  assert.equal(revised.estimateApproval, null);
  assert.equal(revised.estimateRevisionPending, true);
});
