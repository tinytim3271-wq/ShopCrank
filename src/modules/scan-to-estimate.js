/**
 * Scan-to-estimate: trouble codes from the scan tool (RLink X7 / J2534 / OBD
 * bay) pick matching canned services from the shop's menu, merge with the AI
 * diagnosis draft, and become an estimate the customer approves from a link.
 */

const range = (prefix, from, to) => code => code[0] === prefix && Number.parseInt(code.slice(1), 16) >= Number.parseInt(from, 16) && Number.parseInt(code.slice(1), 16) <= Number.parseInt(to, 16);

export const DTC_SERVICE_RULES = Object.freeze([
  { id: 'misfire', label: 'Misfire / ignition', test: code => range('P', '0300', '0312')(code) || range('P', '0350', '0362')(code), keywords: ['tune-up', 'tune up', 'spark plug', 'ignition coil', 'coil'] },
  { id: 'fuel-trim', label: 'Lean / rich fuel trim', test: code => ['P0171', 'P0172', 'P0174', 'P0175', 'P0101', 'P0102', 'P0103'].includes(code), keywords: ['fuel system', 'injector', 'mass air', 'maf', 'vacuum leak', 'smoke test'] },
  { id: 'catalyst', label: 'Catalyst efficiency', test: code => ['P0420', 'P0430'].includes(code) || range('P', '0130', '0167')(code), keywords: ['catalytic', 'oxygen sensor', 'o2 sensor', 'exhaust'] },
  { id: 'cooling', label: 'Cooling system', test: code => ['P0115', 'P0116', 'P0117', 'P0118', 'P0125', 'P0128', 'P0217'].includes(code), keywords: ['coolant', 'thermostat', 'cooling'] },
  { id: 'evap', label: 'EVAP leak', test: range('P', '0440', '0457'), keywords: ['evap', 'smoke test', 'gas cap', 'purge'] },
  { id: 'transmission', label: 'Transmission', test: range('P', '0700', '0799'), keywords: ['transmission'] },
  { id: 'charging', label: 'Charging / battery', test: code => ['P0560', 'P0562', 'P0563', 'P0620', 'P0621', 'P0622', 'P0A80'].includes(code), keywords: ['battery', 'alternator', 'charging'] },
  { id: 'abs', label: 'ABS / wheel speed', test: code => code[0] === 'C', keywords: ['wheel speed', 'abs'] },
  { id: 'network', label: 'Network communication', test: code => code[0] === 'U', keywords: ['network', 'module', 'electrical diagnostic', 'diagnostic'] },
]);

// A general diagnostic service only: "No-Start Diagnostic" tests battery/starter/charging and
// would add an unrelated charge to an EVAP or misfire estimate.
const GENERAL_DIAGNOSTIC = /check engine|engine light|general diagnos|diagnostic fee|diagnosis/i;
const NARROW_DIAGNOSTIC = /no[- ]start|battery|starter|charging|electrical/i;

function generalDiagnosticService(services, used, vehicleText) {
  return services.find(service => !used.has(service.id) && service.active !== false && serviceFitsVehicle(service, vehicleText)
    && GENERAL_DIAGNOSTIC.test(service.name || '') && !NARROW_DIAGNOSTIC.test(service.name || '')) || null;
}

function textOf(service) {
  return `${service.name || ''} ${service.description || ''}`.toLowerCase();
}

function wordPattern(keyword) {
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

/** Cylinder count named in text: V6, V-8, I4, inline-4, "4-cyl", "6 cylinder", ... */
export function cylinderCount(text) {
  const match = /\b(?:v-?(\d{1,2})|i-?(\d)|inline[- ]?(\d)|(\d{1,2})[- ]?cyl(?:inder)?s?)\b/i.exec(String(text || ''));
  return match ? Number(match[1] || match[2] || match[3] || match[4]) : null;
}

/** A cylinder-specific service only fits a vehicle known to have that many cylinders. */
export function serviceFitsVehicle(service, vehicleText = '') {
  const required = cylinderCount(`${service.name || ''} ${service.description || ''}`);
  if (required === null) return true;
  return cylinderCount(vehicleText) === required;
}

function bestService(services, keywords, used, vehicleText = '') {
  let best = null;
  let bestScore = 0;
  for (const service of services) {
    if (used.has(service.id) || service.active === false || !serviceFitsVehicle(service, vehicleText)) continue;
    const text = textOf(service);
    const score = keywords.reduce((total, keyword, index) => total + (wordPattern(keyword).test(text) ? keywords.length - index : 0), 0);
    if (score > bestScore) { best = service; bestScore = score; }
  }
  return best;
}

/** Canned services that match the scanned codes, plus the shop's diagnostic service first. */
export function cannedServicesForCodes(codes = [], services = [], { vehicle = '' } = {}) {
  const normalized = [...new Set(codes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean))];
  const used = new Set();
  const matches = [];
  const diagnostic = generalDiagnosticService(services, used, vehicle);
  if (diagnostic && normalized.length) { used.add(diagnostic.id); matches.push({ service: diagnostic, reason: 'Diagnosis', codes: normalized }); }
  for (const rule of DTC_SERVICE_RULES) {
    const hit = normalized.filter(code => rule.test(code));
    if (!hit.length) continue;
    const service = bestService(services, rule.keywords, used, vehicle);
    if (!service) continue;
    used.add(service.id);
    matches.push({ service, reason: rule.label, codes: hit });
  }
  return matches;
}

const round = value => Math.round((Number(value) || 0) * 100) / 100;

/** A canned service as an estimate line: flat menu price, or hours × shop rate plus parts. */
export function cannedServiceLines(match, { laborRate = 0, scanId = '' } = {}) {
  const { service, codes, reason } = match;
  // The service's saved discount applies here as it does when the menu item is added by hand.
  const discount = Math.min(100, Math.max(0, Number(service.discount) || 0));
  const factor = 1 - discount / 100;
  const discountNote = discount ? ` Includes ${discount}% menu discount.` : '';
  const base = { source: 'scan', cannedServiceId: service.id, scanId, dtcCodes: codes, notes: `${service.description || ''}${service.description ? ' ' : ''}(${reason}: ${codes.join(', ')})${discountNote}`.trim() };
  const menuPrice = Number(service.menuPrice);
  if (service.menuPrice != null && Number.isFinite(menuPrice)) {
    const price = round(menuPrice * factor);
    return [{ ...base, id: `scan-${scanId || 'x'}-${service.id}`, type: 'fee', description: service.name, quantity: 1, unitPrice: price, amount: price, total: price }];
  }
  const hours = Math.max(0, Number(service.laborHours) || 0);
  const rate = round(laborRate * factor);
  const lines = [{ ...base, id: `scan-${scanId || 'x'}-${service.id}`, type: 'labor', description: service.name, hours, quantity: hours, laborRate: rate, unitPrice: rate, total: round(hours * rate) }];
  const parts = round(Math.max(0, Number(service.partsPrice) || 0) * factor);
  if (parts) lines.push({ ...base, id: `scan-${scanId || 'x'}-${service.id}-parts`, type: 'part', description: `${service.name} parts`, quantity: 1, unitPrice: parts, total: parts, priceStatus: 'priced' });
  return lines;
}

/** Canned lines first, then AI-draft lines whose description isn't already covered. */
export function buildScanEstimateLines({ codes = [], services = [], aiLines = [], laborRate = 0, scanId = '', vehicle = '' } = {}) {
  const matches = cannedServicesForCodes(codes, services, { vehicle });
  const canned = matches.flatMap(match => cannedServiceLines(match, { laborRate, scanId }));
  const seen = new Set(canned.map(line => String(line.description).toLowerCase()));
  const extra = aiLines.filter(line => !seen.has(String(line.description || '').toLowerCase()));
  return { lines: [...canned, ...extra], matches };
}

export function scanEstimateSummary({ matches = [], lines = [] }) {
  if (!lines.length) return 'No canned services or AI lines matched these codes.';
  const canned = matches.map(match => `${match.service.name} (${match.codes.join(', ')})`).join('; ');
  return `${lines.length} line${lines.length === 1 ? '' : 's'}${canned ? ` · canned: ${canned}` : ''}`;
}
