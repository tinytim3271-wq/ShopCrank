/** Scan-tool -> AI handoff: normalize DTCs, build the assistant request, and turn its draft into RO lines. */

export const MAX_DTCS = 40;
const MAX_MESSAGE_CHARS = 3900;
const DTC_PATTERN = /^[PBCU][0-3][0-9A-F]{3}$/;
const SYSTEMS = Object.freeze({ P: 'Powertrain', B: 'Body', C: 'Chassis', U: 'Network/communication' });
const STATES = new Set(['stored', 'pending', 'permanent', 'history', 'current']);

export function dtcScope(code) {
  const [system, digit] = code;
  if (system === 'P') {
    if (digit === '0' || digit === '2') return 'generic (SAE)';
    if (digit === '1') return 'manufacturer-specific';
    return Number.parseInt(code.slice(1, 3), 10) >= 34 ? 'generic (SAE)' : 'manufacturer-specific';
  }
  if (digit === '0') return 'generic (SAE)';
  if (digit === '3') return 'reserved';
  return 'manufacturer-specific';
}

/** Accepts "P0300, p0171", ["P0300"], or [{ code, status|description }]. Invalid codes are reported, not guessed. */
export function normalizeDtcs(input) {
  const raw = typeof input === 'string'
    ? input.split(/[\s,;]+/)
    : Array.isArray(input) ? input : [];
  const seen = new Map();
  const invalid = [];
  for (const entry of raw) {
    const code = String(typeof entry === 'object' && entry ? entry.code : entry || '').trim().toUpperCase();
    if (!code) continue;
    if (!DTC_PATTERN.test(code)) {
      if (invalid.length < 10) invalid.push(code.slice(0, 12));
      continue;
    }
    const label = String((typeof entry === 'object' && entry ? entry.status || entry.state || entry.description : '') || '').trim().toLowerCase();
    const state = STATES.has(label) ? label : 'stored';
    if (seen.has(code)) {
      const existing = seen.get(code);
      if (!existing.states.includes(state)) existing.states.push(state);
      continue;
    }
    if (seen.size >= MAX_DTCS) continue;
    seen.set(code, { code, states: [state], system: SYSTEMS[code[0]], scope: dtcScope(code) });
  }
  return { dtcs: [...seen.values()], invalid };
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Builds the assistant prompt for a scan. Customer contact details are not sent. */
export function buildDiagnosticAiMessage({ order = {}, vehicle, vin, mileage, complaint, dtcs = [], readings = [], milOn = null } = {}) {
  const vehicleText = clean(vehicle || order.vehicle, 160) || 'Unknown vehicle';
  const vinText = clean(vin || order.vin, 17).toUpperCase();
  const complaintText = clean(complaint || order.complaint, 600) || 'Not recorded';
  const codeLines = dtcs.map(item => `- ${item.code} (${item.states.join('/')}, ${item.system}, ${item.scope})`);
  const readingLines = (Array.isArray(readings) ? readings : []).slice(0, 15)
    .map(reading => `- ${clean(reading?.name, 40)}: ${clean(reading?.value, 20)} ${clean(reading?.unit, 10)}`.trim())
    .filter(line => line.length > 3);
  const header = [
    'Scan tool results for a repair order. Diagnose from this evidence.',
    `Repair order: ${clean(order.id, 40) || 'not linked'}`,
    `Customer name: ${clean(order.customer, 80) || 'unknown'}`,
    `Vehicle: ${vehicleText}${vinText ? ` · VIN ${vinText}` : ''}${mileage ? ` · ${clean(mileage, 12)} mi` : ''}`,
    `Complaint: ${complaintText}`,
    `Check engine light: ${milOn === true ? 'ON' : milOn === false ? 'off' : 'unknown'}`,
    'Trouble codes:',
    ...(codeLines.length ? codeLines : ['- none reported']),
  ];
  const instructions = [
    'Respond with: (1) the most likely causes ranked with the evidence for each; (2) the pinpoint tests that confirm or rule out each cause, in order; (3) related codes or TSB topics worth checking.',
    'Then call prepare_estimate_work_order with this customer, vehicle, and complaint: one diagnostic labor line, plus the repair labor and parts for the top cause only.',
    'Leave every part unpriced (priceStatus pending) and every labor line marked as a suggestion to verify against the shop labor guide. Do not present a likely cause as confirmed.',
  ];
  let message = [...header, ...(readingLines.length ? ['Live data:', ...readingLines] : []), ...instructions].join('\n');
  if (message.length > MAX_MESSAGE_CHARS) message = [...header, ...instructions].join('\n').slice(0, MAX_MESSAGE_CHARS);
  return message;
}

/**
 * Converts the assistant's estimate draft into RO estimate lines. Parts are
 * always unpriced (the AI must not price parts); labor keeps the AI hours but
 * is labeled as a suggestion pending labor-guide verification.
 */
export function diagnosticDraftToOrderLines(action = {}, { laborRate = 0, scanId = '', codes = [] } = {}) {
  const draft = action.draft || action;
  const tag = codes.length ? ` (${codes.slice(0, 6).join(', ')})` : '';
  const parts = (draft.parts || []).slice(0, 20).map((part, index) => ({
    id: `ai-diag-part-${index + 1}`,
    type: 'part',
    description: clean(part.description, 300) || 'Part',
    notes: clean(part.notes, 500),
    partNumber: clean(part.partNumber, 60),
    quantity: Math.max(1, Math.trunc(Number(part.quantity) || 1)),
    unitPrice: 0,
    priceStatus: 'pending',
    source: 'ai_diagnostics',
    aiDiagnostics: { scanId },
  }));
  const labor = (draft.labor || []).slice(0, 10).map((item, index) => ({
    id: `ai-diag-labor-${index + 1}`,
    type: 'labor',
    description: clean(item.description, 300) || 'Diagnostic labor',
    notes: clean(item.notes, 500),
    hours: Math.min(40, Math.max(0, Number(item.hours) || 0)),
    laborRate: Math.max(0, Number(laborRate) || 0),
    laborSource: `AI suggestion from scan${tag}; verify against the labor guide before authorization`,
    source: 'ai_diagnostics',
    aiDiagnostics: { scanId },
  }));
  return [...labor, ...parts];
}

export function estimateDraftAction(result = {}) {
  return (Array.isArray(result.actions) ? result.actions : []).find(action => action?.kind === 'estimate_work_order_draft') || null;
}
