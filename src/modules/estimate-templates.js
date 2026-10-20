import {
  afterMidnightFeeLine,
  calculateEstimate,
  discountedTaxTotals,
  normalizeEstimateLine,
  SHOP_SUPPLIES_RULES,
} from './estimate-workflow.js';

const money = value => Math.round((Number(value) || 0) * 100) / 100;
const REFERENCE_ESTIMATE_RULES = Object.freeze({ laborRate: 140, taxRate: 8.25 });

export function calculateShopEstimate(lines = [], {
  taxRate = 0,
  laborRate = 0,
  discountPercent = 0,
  discountReason = '',
  shopSupplies,
  taxPolicy,
} = {}) {
  const normalizedLines = lines.map((line, index) => normalizeEstimateLine(
    line.type === 'labor' && line.laborRate == null ? { ...line, laborRate } : line,
    index,
  ));
  const labor = normalizedLines
    .filter(line => line.type === 'labor' && line.approvalStatus !== 'declined')
    .reduce((sum, line) => sum + line.total, 0);
  const automaticSupplies = Math.min(
    SHOP_SUPPLIES_RULES.shopSuppliesCap,
    labor * SHOP_SUPPLIES_RULES.shopSuppliesRate / 100,
  );
  const supplies = labor > 0
    ? money(Math.min(SHOP_SUPPLIES_RULES.shopSuppliesCap, Math.max(0, shopSupplies ?? automaticSupplies)))
    : 0;
  const base = calculateEstimate(
    normalizedLines,
    0,
    supplies ? [{ description: 'Shop supplies', amount: supplies }] : [],
    taxPolicy,
  );
  const safeTaxRate = Math.max(0, Number(taxRate) || 0);
  return {
    ...base,
    grossSubtotal: base.subtotal,
    ...discountedTaxTotals(base, discountPercent, safeTaxRate),
    discountReason: String(discountReason || ''),
    taxRate: safeTaxRate,
  };
}

const referenceLines = [
  {
    id: 'part-headlamp',
    type: 'part',
    description: 'Passenger xenon headlamp',
    notes: 'Right side, xenon without adaptive. DEPO 3401157RMUSHM2.',
    quantity: 1,
    unitPrice: 493.79,
    partNumber: '3401157RMUSHM2',
    brand: 'DEPO',
  },
  {
    id: 'part-fog-lamp',
    type: 'part',
    description: 'Passenger fog lamp',
    notes: 'Right side, without AMG styling package. TYC 19042100.',
    quantity: 1,
    unitPrice: 17.02,
    partNumber: '19042100',
    brand: 'TYC',
  },
  {
    id: 'part-xenon-module',
    type: 'part',
    description: 'Xenon headlamp control module',
    notes: 'Listed as 222-900-33-00; confirm the module number before ordering.',
    quantity: 1,
    unitPrice: 116.40,
    partNumber: '222-900-33-00',
  },
  {
    id: 'part-bumper',
    type: 'part',
    description: 'Front bumper cover',
    notes: 'Without AMG, without Parktronic, CAPA, primed. TECHPRO MB1000458.',
    quantity: 1,
    unitPrice: 362.79,
    partNumber: 'MB1000458',
    brand: 'TECHPRO',
  },
  {
    id: 'part-fender',
    type: 'part',
    description: 'Passenger front fender',
    notes: 'Front right, CAPA. TECHPRO MB1241149. Beyond repair.',
    quantity: 1,
    unitPrice: 374.79,
    partNumber: 'MB1241149',
    brand: 'TECHPRO',
  },
  {
    id: 'part-fender-covers',
    type: 'part',
    description: 'Upper and lower passenger fender covers',
    notes: 'Damaged; parts have not been matched to a listing and remain unpriced.',
    quantity: 1,
    unitPrice: 0,
    priceStatus: 'pending',
  },
  {
    id: 'labor-collision-repair',
    type: 'labor',
    description: 'Collision component replacement labor',
    notes: '5.3 hours from Open Labor Project estimates for this vehicle: fender 3.7, headlamp 0.9, and one fender liner 0.7. These are not ALLDATA or Mitchell times, are not copied from a labor guide, and are not expert-verified.',
    hours: 5.3,
    laborRate: REFERENCE_ESTIMATE_RULES.laborRate,
    laborSource: 'Open Labor Project estimate',
  },
];

const referenceTotals = calculateShopEstimate(referenceLines, {
  taxRate: REFERENCE_ESTIMATE_RULES.taxRate,
  discountPercent: 10,
  discountReason: 'Tech-student discount',
  shopSupplies: 20,
});

export const REFERENCE_ESTIMATE = Object.freeze({
  id: 'reference-estimate-est-2026-1004-01',
  number: 'EST-2026-1004-01',
  date: '2026-10-04',
  validThrough: '2026-10-18',
  status: 'draft',
  template: true,
  customer: {
    name: 'Jordan Example',
    phone: '555-0100',
    email: 'customer@example.test',
    address: '123 Example Street, Sample City, TX 00000',
    role: 'Claimant',
  },
  vehicle: {
    description: '2016 Mercedes-Benz GLA250',
    vin: '1M8GDM9AXKP042788',
    plate: 'DEMO-01',
  },
  insurance: {
    company: 'Example Insurance',
    policy: 'TEST-POLICY-001',
    claimNumber: '',
  },
  complaint: 'Deer collision. Claimant was not injured. No structural damage was found.',
  inspectionNotes: 'Passenger-side lighting, bumper, fender, and upper/lower fender covers are damaged.',
  requestedServices: [
    'Replace passenger xenon headlamp',
    'Replace passenger fog lamp',
    'Replace xenon headlamp control module',
    'Replace front bumper cover',
    'Replace passenger front fender',
    'Replace upper and lower passenger fender covers (parts remain unpriced)',
  ],
  exclusions: [
    'Paint is not included.',
    'Upper and lower fender covers remain unpriced.',
    'Hidden damage and any additional work require a revised estimate and customer authorization.',
  ],
  shopNotes: [
    'Obtain written authorization before sending the estimate or customer records.',
    'Verify any billing or photo-delivery address with the customer before use.',
  ],
  lines: referenceTotals.lines,
  fees: referenceTotals.fees,
  ...referenceTotals,
});

export function workOrderDraftFromEstimate(estimate = REFERENCE_ESTIMATE) {
  const customer = typeof estimate.customer === 'object' ? estimate.customer : { name: estimate.customer };
  const vehicle = typeof estimate.vehicle === 'object' ? estimate.vehicle : { description: estimate.vehicle };
  const insurance = estimate.insurance || {};
  const laborSource = (estimate.lines || [])
    .filter(line => line.type === 'labor')
    .map(line => line.notes || line.laborSource)
    .filter(Boolean)
    .join(' ');
  const complaintParts = [
    `Claimant: ${customer.name || 'Not provided'}.`,
    estimate.complaint,
    insurance.company || insurance.policy
      ? `Insurance: ${insurance.company || 'Carrier not provided'}; policy ${insurance.policy || 'not provided'}; claim number ${insurance.claimNumber || 'not yet assigned'}.`
      : '',
    laborSource ? `Labor source: ${laborSource}` : '',
  ].filter(Boolean);
  return {
    sourceEstimateNumber: estimate.number || '',
    customer: customer.name || '',
    phone: customer.phone || estimate.phone || '',
    email: customer.email || estimate.email || '',
    address: customer.address || '',
    vehicle: vehicle.description || '',
    vin: vehicle.vin || estimate.vin || '',
    complaint: complaintParts.join('\n'),
    requestedServices: (estimate.requestedServices || (estimate.lines || []).map(line => line.description)).join('\n'),
    estimate: calculateShopEstimate(estimate.lines || [], {
      taxRate: estimate.taxRate,
      laborRate: estimate.laborRate,
      discountPercent: estimate.discountPercent,
      discountReason: estimate.discountReason,
      shopSupplies: estimate.fees?.find(fee => fee.description === 'Shop supplies')?.amount,
      taxPolicy: estimate.taxPolicy,
    }),
    exclusions: estimate.exclusions || [],
    insurance,
    shopNotes: (estimate.shopNotes || []).map(String),
    plate: vehicle.plate || '',
  };
}

export function estimateFromAssistantDraft(action = {}, { laborRate = 0, taxRate = 0, shopSupplies } = {}) {
  const draft = action.draft || action;
  const resolvedLaborRate = Math.max(0, Number(laborRate) || 0);
  const partLines = (draft.parts || []).map((part, index) => ({
    id: `assistant-part-${index + 1}`,
    type: 'part',
    description: String(part.description || 'Part'),
    notes: String(part.notes || ''),
    quantity: Math.max(0, Number(part.quantity) || 0),
    unitPrice: Math.max(0, Number(part.unitPrice) || 0),
    partNumber: String(part.partNumber || ''),
    priceStatus: part.priceStatus === 'pending' ? 'pending' : 'priced',
  }));
  const laborLines = (draft.labor || []).map((labor, index) => ({
    id: `assistant-labor-${index + 1}`,
    type: 'labor',
    description: String(labor.description || 'Labor'),
    notes: String(labor.notes || labor.source || ''),
    hours: Math.max(0, Number(labor.hours) || 0),
    laborRate: resolvedLaborRate,
    laborSource: String(labor.source || 'Customer conversation; verify before authorization'),
  }));
  const feeLines = draft.afterMidnightFee ? [afterMidnightFeeLine('assistant-fee-after-midnight')] : [];
  const totals = calculateShopEstimate([...partLines, ...laborLines, ...feeLines], {
    laborRate: resolvedLaborRate,
    taxRate,
    discountPercent: draft.discountPercent,
    discountReason: draft.discountReason,
    shopSupplies,
  });
  return {
    id: `assistant-estimate-${Date.now()}`,
    number: '',
    status: 'draft',
    customer: {
      name: String(draft.customer?.name || ''),
      phone: String(draft.customer?.phone || ''),
      email: String(draft.customer?.email || ''),
      address: String(draft.customer?.address || ''),
    },
    vehicle: {
      description: String(draft.vehicle?.description || ''),
      vin: String(draft.vehicle?.vin || ''),
      plate: String(draft.vehicle?.plate || ''),
    },
    complaint: String(draft.complaint || ''),
    requestedServices: (draft.requestedServices || []).map(String),
    exclusions: (draft.exclusions || []).map(String),
    shopNotes: (draft.shopNotes || []).map(String),
    lines: totals.lines,
    ...totals,
  };
}
