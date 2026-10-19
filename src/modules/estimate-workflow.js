const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

export const SHOP_SUPPLIES_RULES = Object.freeze({
  shopSuppliesRate: 3,
  shopSuppliesCap: 20,
});

export const AFTER_MIDNIGHT_FEE_PRESET = Object.freeze({
  code: 'after-midnight',
  type: 'fee',
  description: 'a $200 flat fee for labor performed between midnight and 6 AM, itemized as its own line on the work order.',
  quantity: 1,
  unitPrice: 200,
  amount: 200,
});

export function afterMidnightFeeLine(id = 'fee-after-midnight') {
  return { ...AFTER_MIDNIGHT_FEE_PRESET, id };
}

export function isDeclinedEstimateLine(line) {
  return line?.approvalStatus === 'declined';
}

export function billableEstimateLines(lines = []) {
  return lines.filter(line => !isDeclinedEstimateLine(line));
}

export function normalizeTechnicianIds(line = {}) {
  const source = Array.isArray(line.technicianIds)
    ? line.technicianIds
    : line.technicianId ? [line.technicianId] : [];
  return [...new Set(source.map(value => String(value || '').trim()).filter(Boolean))];
}

export function estimatePartPriceStatus(previousStatus, unitPrice) {
  return previousStatus === 'pending' && Number(unitPrice) <= 0 ? 'pending' : 'priced';
}

export function orderHasTechnician(order = {}, technician = {}) {
  const names = [technician.name, technician.techName].filter(Boolean);
  if (order.tech && names.includes(order.tech)) return true;
  const id = String(technician.id || '');
  if (Array.isArray(order.assignments) && order.assignments.some(item => (
    (id && item.employeeId === id) || names.includes(item.name)
  ))) return true;
  return Boolean(id && (order.estimate?.lines || []).some(line => (
    line.type === 'labor' && normalizeTechnicianIds(line).includes(id)
  )));
}

export function normalizeEstimateLine(line = {}, index = 0) {
  const type = ['part', 'fee'].includes(line.type) ? line.type : 'labor';
  const quantity = type === 'fee'
    ? 1
    : Math.max(0, Number(line.quantity ?? (type === 'part' ? 1 : line.hours)) || 0);
  const unitPrice = Math.max(0, Number(line.unitPrice ?? (
    type === 'part' ? line.price : type === 'fee' ? line.amount : line.laborRate
  )) || 0);
  const hours = type === 'labor' ? Math.max(0, Number(line.hours ?? quantity) || 0) : 0;
  const laborRate = type === 'labor' ? Math.max(0, Number(line.laborRate ?? unitPrice) || 0) : 0;
  const total = type === 'labor'
    ? roundMoney(hours * laborRate)
    : roundMoney(quantity * unitPrice);
  return {
    ...line,
    id: String(line.id || `line-${index + 1}`),
    type,
    description: String(line.description || line.service || line.name || (
      type === 'part' ? 'Part' : type === 'fee' ? 'Fee' : 'Labor'
    )),
    notes: String(line.notes || line.explanation || ''),
    partNumber: type === 'part' ? String(line.partNumber || line.part_number || line.inventorySku || '') : '',
    quantity,
    unitPrice,
    hours,
    laborRate,
    total,
    technicianIds: type === 'labor' ? normalizeTechnicianIds(line) : [],
    approvalStatus: ['approved', 'declined'].includes(line.approvalStatus) ? line.approvalStatus : 'pending',
  };
}

export function laborLinePrintRows(lines = [], technicians = []) {
  const names = new Map(technicians.map(technician => [
    String(technician.id || ''),
    String(technician.name || technician.techName || technician.id || 'Technician unavailable'),
  ]));
  return lines
    .map((line, index) => normalizeEstimateLine(line, index))
    .filter(line => line.type === 'labor')
    .flatMap(line => {
      const technicianIds = normalizeTechnicianIds(line);
      const assignments = !technicianIds.length ? [null] : technicianIds;
      return assignments.map((technicianId, index) => ({
        line,
        technicianId,
        technicianName: technicianId ? names.get(technicianId) || 'Technician unavailable' : 'Unassigned',
        lineTotal: index === 0 ? line.total : null,
      }));
    });
}

export function calculateEstimate(lines = [], taxRate = 0, fees = []) {
  const normalizedLines = lines.map((line, index) => normalizeEstimateLine(line, index));
  // Declined lines stay visible for audit, but must not affect money totals.
  const billableLines = billableEstimateLines(normalizedLines);
  const normalizedFees = fees.map(fee => ({
    ...fee,
    description: String(fee.description || 'Fee'),
    amount: roundMoney(Math.max(0, Number(fee.amount) || 0)),
  }));
  const labor = roundMoney(billableLines
    .filter(line => line.type === 'labor')
    .reduce((sum, line) => sum + line.total, 0));
  const parts = roundMoney(billableLines
    .filter(line => line.type === 'part')
    .reduce((sum, line) => sum + line.total, 0));
  const lineFees = roundMoney(billableLines
    .filter(line => line.type === 'fee')
    .reduce((sum, line) => sum + line.total, 0));
  const feeTotal = roundMoney(lineFees + normalizedFees.reduce((sum, fee) => sum + fee.amount, 0));
  const subtotal = roundMoney(labor + parts + feeTotal);
  const safeTaxRate = Math.max(0, Number(taxRate) || 0);
  const tax = roundMoney(subtotal * safeTaxRate / 100);
  return {
    lines: normalizedLines,
    fees: normalizedFees,
    labor,
    laborHours: roundMoney(billableLines.reduce((sum, line) => sum + line.hours, 0)),
    parts,
    lineFees,
    feeTotal,
    subtotal,
    taxRate: safeTaxRate,
    tax,
    total: roundMoney(subtotal + tax),
  };
}

function calculateShopTotals(lines, estimate, { repriceSupplies = false } = {}) {
  const taxRate = Math.max(0, Number(estimate.taxRate) || 0);
  let fees = estimate.fees || [];
  let totals = calculateEstimate(lines, taxRate, fees);
  const hasSuppliesFee = fees.some(fee => /shop supplies/i.test(fee.description));

  if (repriceSupplies && hasSuppliesFee) {
    const supplies = totals.labor > 0
      ? roundMoney(Math.min(
        SHOP_SUPPLIES_RULES.shopSuppliesCap,
        totals.labor * SHOP_SUPPLIES_RULES.shopSuppliesRate / 100,
      ))
      : 0;
    fees = fees.map(fee => /shop supplies/i.test(fee.description) ? { ...fee, amount: supplies } : fee)
      .filter(fee => !/shop supplies/i.test(fee.description) || fee.amount > 0);
    totals = calculateEstimate(lines, taxRate, fees);
  }

  const discountPercent = Math.min(100, Math.max(0, Number(estimate.discountPercent) || 0));
  const discountAmount = roundMoney(totals.subtotal * discountPercent / 100);
  const subtotal = roundMoney(totals.subtotal - discountAmount);
  const tax = roundMoney(subtotal * taxRate / 100);
  return {
    ...totals,
    grossSubtotal: totals.subtotal,
    discountPercent,
    discountReason: String(estimate.discountReason || ''),
    discountAmount,
    subtotal,
    tax,
    total: roundMoney(subtotal + tax),
  };
}

export function approvedEstimate(estimate = {}, decisions = {}) {
  const lines = (estimate.lines || []).map((line, index) => {
    const normalized = normalizeEstimateLine(line, index);
    return {
      ...normalized,
      approvalStatus: decisions[normalized.id] === 'declined' ? 'declined' : 'approved',
    };
  });
  const approvedLines = lines.filter(line => line.approvalStatus === 'approved');
  const totals = calculateShopTotals(approvedLines, estimate, { repriceSupplies: true });
  return {
    ...estimate,
    ...totals,
    lines,
    approvedLineCount: approvedLines.length,
    declinedLineCount: lines.length - approvedLines.length,
  };
}

/**
 * Full-card decline: every line is declined and money totals are zeroed.
 * Fees are retained for audit but do not contribute to subtotal/tax/total.
 */
export function declinedEstimate(estimate = {}) {
  const decisions = Object.fromEntries(
    (estimate.lines || []).map((line, index) => [normalizeEstimateLine(line, index).id, 'declined']),
  );
  // approvedEstimate would still bill fees when no lines are approved; clear
  // fee money while preserving the fee list for history.
  const next = approvedEstimate({ ...estimate, fees: [] }, decisions);
  return {
    estimate: {
      ...next,
      fees: (estimate.fees || []).map(fee => ({
        ...fee,
        description: String(fee.description || 'Fee'),
        amount: roundMoney(Math.max(0, Number(fee.amount) || 0)),
      })),
      labor: 0,
      laborHours: 0,
      parts: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      approvedLineCount: 0,
      declinedLineCount: next.lines.length,
    },
    decisions,
  };
}

export function invoiceRecordForOrder(order, issuedAt = new Date()) {
  const source = order.estimate || {};
  const estimate = calculateShopTotals(source.lines || [], source, { repriceSupplies: true });
  const number = `INV-${String(order.id || issuedAt.getTime()).replace(/^RO-/i, '').replace(/[^A-Za-z0-9-]/g, '')}`;
  const due = new Date(issuedAt);
  due.setDate(due.getDate() + 14);
  const amount = source.lines?.length ? estimate.total : roundMoney(order.total ?? estimate.total);
  return {
    id: number,
    number,
    ro: order.id,
    customer: order.customer,
    vehicle: order.vehicle,
    amount,
    grossSubtotal: estimate.grossSubtotal,
    subtotal: estimate.subtotal,
    discountPercent: estimate.discountPercent,
    discountAmount: estimate.discountAmount,
    discountReason: estimate.discountReason,
    fees: estimate.fees,
    tax: estimate.tax,
    taxRate: Math.max(0, Number(estimate.taxRate) || 0),
    status: 'sent',
    date: issuedAt.toISOString().slice(0, 10),
    due: due.toISOString().slice(0, 10),
    lines: billableEstimateLines(estimate.lines).map((line, index) => normalizeEstimateLine(line, index)),
    sourceEstimateApproval: order.estimateApproval || null,
    createdAt: issuedAt.toISOString(),
  };
}

export function workOrderWithEditedEstimate(order = {}, estimate = {}, editedAt = new Date().toISOString()) {
  const recalculated = calculateEstimate(estimate.lines || [], estimate.taxRate, estimate.fees || []);
  const hadApproval = Boolean(
    order.linesLockedAt
    || order.estimateApproval?.status === 'approved'
    || ['approved', 'in_progress', 'waiting_parts', 'completed', 'invoiced'].includes(order.status),
  );
  return {
    ...order,
    estimate: {
      ...estimate,
      ...recalculated,
      summary: estimate.summary || order.estimate?.summary || '',
      generatedAt: estimate.generatedAt || order.estimate?.generatedAt || editedAt,
      revisedAt: editedAt,
    },
    labor: recalculated.labor,
    laborHours: recalculated.laborHours,
    parts: recalculated.parts,
    tax: recalculated.tax,
    total: recalculated.total,
    estimateApproval: hadApproval ? null : order.estimateApproval,
    linesLockedAt: hadApproval ? null : order.linesLockedAt,
    estimateRevisionPending: hadApproval || Boolean(order.estimateRevisionPending),
    estimateRevisionPreviousStatus: hadApproval ? order.status : order.estimateRevisionPreviousStatus,
    updatedAt: order.updatedAt,
  };
}

const CLOSED_ORDER_STATUSES = new Set(['invoiced', 'paid', 'closed', 'cancelled', 'canceled', 'archived']);

export function ordersAcceptingEstimateLines(orders = []) {
  return orders.filter(order => order?.id && !CLOSED_ORDER_STATUSES.has(String(order.status || '').toLowerCase()));
}

/**
 * Adds quoted/looked-up lines (parts, labor) to a repair order's estimate.
 * Line ids are made unique within the order so repeated adds never collide,
 * and totals are recalculated through workOrderWithEditedEstimate.
 */
export function appendEstimateLinesToOrder(order = {}, newLines = [], { editedAt = new Date().toISOString(), taxRate } = {}) {
  if (!order?.id) throw new TypeError('Select a repair order first');
  if (CLOSED_ORDER_STATUSES.has(String(order.status || '').toLowerCase())) {
    throw new TypeError(`${order.id} is ${order.status}; reopen it before adding lines`);
  }
  const estimate = order.estimate || {};
  const existing = Array.isArray(estimate.lines) ? estimate.lines : [];
  const usedIds = new Set(existing.map(line => String(line.id)));
  const additions = (Array.isArray(newLines) ? newLines : [newLines]).filter(Boolean).map((line, index) => {
    const base = String(line.id || `line-${existing.length + index + 1}`);
    let id = base;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    usedIds.add(id);
    return { ...line, id, approvalStatus: 'pending', addedAt: editedAt };
  });
  if (!additions.length) return order;
  return workOrderWithEditedEstimate(order, {
    ...estimate,
    taxRate: estimate.taxRate ?? taxRate ?? 0,
    lines: [...existing, ...additions],
  }, editedAt);
}

export function invoiceWithEditedWorkOrder(invoice = {}, order = {}, editedAt = new Date().toISOString()) {
  const source = order.estimate || {};
  const estimate = calculateEstimate(source.lines || [], source.taxRate, source.fees || []);
  return {
    ...invoice,
    amount: estimate.total,
    subtotal: estimate.subtotal,
    tax: estimate.tax,
    taxRate: estimate.taxRate,
    fees: estimate.fees,
    lines: billableEstimateLines(estimate.lines).map((line, index) => normalizeEstimateLine(line, index)),
    signature: null,
    sourceEstimateApproval: null,
    revisedAt: editedAt,
  };
}
