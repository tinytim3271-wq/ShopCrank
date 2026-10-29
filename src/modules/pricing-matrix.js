/**
 * Parts and labor pricing matrix with margin protection.
 *
 * Parts: retail = cost × the multiplier for the cost tier the part falls in
 * (cheap parts carry a higher markup, as in a standard shop matrix).
 * Labor: a rate per labor category (standard, diagnostic, heavy, electrical…).
 * Margin protection flags any part line whose price gives less than the shop's
 * minimum gross margin, and the matrix price that would fix it.
 * Settings are stored as shopsettings/pricing.
 */

export const DEFAULT_PARTS_MATRIX = Object.freeze([
  { upTo: 10, multiplier: 2.5 },
  { upTo: 25, multiplier: 2.25 },
  { upTo: 50, multiplier: 2.0 },
  { upTo: 100, multiplier: 1.8 },
  { upTo: 250, multiplier: 1.6 },
  { upTo: 500, multiplier: 1.45 },
  { upTo: 1000, multiplier: 1.35 },
  { upTo: null, multiplier: 1.25 },
]);

export const DEFAULT_PRICING = Object.freeze({
  enabled: true,
  partsMatrix: DEFAULT_PARTS_MATRIX,
  minPartsMarginPercent: 35,
  laborRates: { standard: 0, diagnostic: 0, heavy: 0, electrical: 0 },
});

const round = value => Math.round((Number(value) || 0) * 100) / 100;

function sortedTiers(tiers) {
  const valid = (Array.isArray(tiers) ? tiers : []).map(tier => ({
    upTo: tier.upTo === null || tier.upTo === '' || tier.upTo === undefined || !Number.isFinite(Number(tier.upTo)) ? null : Number(tier.upTo),
    multiplier: Number(tier.multiplier),
  })).filter(tier => Number.isFinite(tier.multiplier) && tier.multiplier >= 1 && tier.multiplier <= 10);
  valid.sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  return valid.length ? valid : [...DEFAULT_PARTS_MATRIX];
}

export function pricingSettings(record = {}) {
  return {
    enabled: record.enabled !== false,
    partsMatrix: sortedTiers(record.partsMatrix),
    minPartsMarginPercent: Number.isFinite(Number(record.minPartsMarginPercent)) ? Math.min(90, Math.max(0, Number(record.minPartsMarginPercent))) : DEFAULT_PRICING.minPartsMarginPercent,
    laborRates: { ...DEFAULT_PRICING.laborRates, ...(record.laborRates || {}) },
  };
}

export function partsMultiplier(cost, settings = pricingSettings()) {
  const value = Number(cost);
  const tier = settings.partsMatrix.find(item => item.upTo === null || value <= item.upTo) || settings.partsMatrix[settings.partsMatrix.length - 1];
  return tier.multiplier;
}

export function matrixPartPrice(cost, settings = pricingSettings()) {
  const value = Number(cost);
  if (!Number.isFinite(value) || value <= 0) return null;
  return round(value * partsMultiplier(value, settings));
}

export function marginPercent(price, cost) {
  const p = Number(price);
  const c = Number(cost);
  return p > 0 && c >= 0 ? Math.round(((p - c) / p) * 1000) / 10 : null;
}

export function lineCost(line = {}, inventory = []) {
  const direct = [line.cost, line.unitCost, line.partstech?.cost].map(Number).find(value => Number.isFinite(value) && value > 0);
  if (direct) return direct;
  const stocked = inventory.find(item => (line.inventoryId && item.id === line.inventoryId) || (line.inventorySku && String(item.sku || '').toLowerCase() === String(line.inventorySku).toLowerCase()));
  const cost = Number(stocked?.cost);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

/** Price new part lines from the matrix when they arrive with a cost but no shop price (or only a cost-plus price). Supplier list prices are kept. */
export function applyPartsMatrix(lines = [], settings = pricingSettings(), inventory = []) {
  if (!settings.enabled) return lines;
  return lines.map(line => {
    const costPriced = ['cost', 'cost_markup'].includes(line.partstech?.priceBasis);
    if (line.type !== 'part' || (Number(line.unitPrice) > 0 && !costPriced)) return line;
    const cost = lineCost(line, inventory);
    const price = matrixPartPrice(cost, settings);
    if (price === null) return line;
    const quantity = Math.max(1, Number(line.quantity) || 1);
    return { ...line, cost, unitPrice: price, total: round(price * quantity), priceStatus: 'priced', priceSource: 'matrix' };
  });
}

/** Part lines below the minimum margin, with the matrix price that would restore it. */
export function marginWarnings(lines = [], settings = pricingSettings(), inventory = []) {
  const warnings = [];
  for (const line of lines) {
    if (line.type !== 'part' || line.approvalStatus === 'declined') continue;
    const cost = lineCost(line, inventory);
    const price = Number(line.unitPrice);
    if (cost === null || !(price > 0)) continue;
    const margin = marginPercent(price, cost);
    if (margin !== null && margin < settings.minPartsMarginPercent) {
      warnings.push({ lineId: line.id, description: line.description, cost, price, margin, suggestedPrice: matrixPartPrice(cost, settings) });
    }
  }
  return warnings;
}

export function laborRateFor(category, settings = pricingSettings(), fallback = 0) {
  const rate = Number(settings.laborRates?.[category]);
  return rate > 0 ? rate : Number(fallback) || 0;
}

const LABOR_CATEGORY_PATTERNS = Object.freeze({
  diagnostic: /diagnos|troubleshoot|check engine|no[- ]start|inspection/i,
  electrical: /electric|wiring|battery|alternator|starter|module|sensor/i,
  heavy: /engine (replace|rebuild|overhaul)|transmission (replace|rebuild|overhaul)|head gasket|timing (chain|belt)|differential|clutch/i,
});

export function laborCategoryFor(line = {}) {
  if (line.laborCategory) return String(line.laborCategory);
  const text = `${line.description || ''} ${line.notes || ''}`;
  return Object.entries(LABOR_CATEGORY_PATTERNS).find(([, pattern]) => pattern.test(text))?.[0] || 'standard';
}

/** Give labor lines at the shop's default rate the rate for their category, when one is set. */
export function applyLaborMatrix(lines = [], settings = pricingSettings(), shopRate = 0) {
  if (!settings.enabled) return lines;
  return lines.map(line => {
    if (line.type === 'part' || line.type === 'fee') return line;
    const current = Number(line.laborRate ?? line.unitPrice);
    if (current > 0 && current !== Number(shopRate)) return line;
    const category = laborCategoryFor(line);
    const rate = laborRateFor(category, settings, 0);
    if (!(rate > 0)) return line;
    const hours = Number(line.hours ?? line.quantity) || 0;
    return { ...line, laborCategory: category, laborRate: rate, unitPrice: rate, total: round(hours * rate) };
  });
}

export function matrixText(tiers = DEFAULT_PARTS_MATRIX) {
  return sortedTiers(tiers).map(tier => `${tier.upTo === null ? 'over' : `up to ${tier.upTo}`}: ${tier.multiplier}`).join('\n');
}

/** Parse "up to 10: 2.5" / "over: 1.25" lines from the settings textarea. */
export function parseMatrixText(text) {
  const tiers = String(text || '').split('\n').map(line => {
    const match = /^\s*(?:up\s*to\s*\$?([\d.]+)|over|above|\*)\s*[:=]\s*([\d.]+)\s*x?\s*$/i.exec(line);
    if (!match) return null;
    return { upTo: match[1] === undefined ? null : Number(match[1]), multiplier: Number(match[2]) };
  }).filter(Boolean);
  if (!tiers.some(tier => tier.upTo === null) && tiers.length) tiers.push({ upTo: null, multiplier: tiers[tiers.length - 1].multiplier });
  return sortedTiers(tiers);
}

export function marginWarningsHtml(warnings = [], { money = value => `$${Number(value).toFixed(2)}`, escapeHtml = value => String(value ?? '') } = {}) {
  if (!warnings.length) return '';
  return `<div class="margin-warning" role="alert"><strong>Margin check</strong>${warnings.map(item => `<p>${escapeHtml(item.description)}: ${item.margin}% margin at ${money(item.price)} (cost ${money(item.cost)}). Matrix price ${money(item.suggestedPrice)}. <button type="button" class="mini-action" data-apply-matrix="${escapeHtml(item.lineId)}">Use matrix price</button></p>`).join('')}</div>`;
}

export function pricingSettingsHtml(record = {}, { canSave = false, escapeHtml = value => String(value ?? ''), icon = () => '' } = {}) {
  const settings = pricingSettings(record);
  const disabled = canSave ? '' : 'disabled';
  return `<section class="settings-panel pricing-matrix"><div class="statement-head"><div><div class="eyebrow">Margin protection</div><h2>Parts &amp; labor pricing matrix</h2><p>Parts with a known cost (PartsTech, inventory) are priced from the matrix, and estimates warn when a part sells below your minimum margin.</p></div>${icon('percent', 20)}</div>
  <form id="pricing-matrix-form" class="form-grid">
    <label class="toggle-field full"><input type="checkbox" name="matrixEnabled" ${settings.enabled ? 'checked' : ''} ${disabled}/><span>Price parts from the matrix</span></label>
    <label class="full">Parts markup by cost (one tier per line, cost × multiplier)<textarea name="partsMatrix" rows="8" ${disabled}>${escapeHtml(matrixText(settings.partsMatrix))}</textarea></label>
    <label>Minimum parts margin %<input name="minPartsMarginPercent" type="number" min="0" max="90" step="1" value="${escapeHtml(settings.minPartsMarginPercent)}" ${disabled}/></label>
    ${Object.entries(settings.laborRates).map(([key, value]) => `<label>${escapeHtml(key[0].toUpperCase() + key.slice(1))} labor rate<input name="laborRate_${escapeHtml(key)}" type="number" min="0" step="0.01" value="${escapeHtml(value || '')}" placeholder="Shop default" ${disabled}/></label>`).join('')}
    ${canSave ? `<div class="full"><button class="primary" type="submit">${icon('save', 14)} Save pricing</button></div>` : ''}
  </form></section>`;
}

export function pricingRecordFromForm(values = {}, current = {}) {
  const laborRates = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith('laborRate_')) continue;
    const rate = Number(value);
    laborRates[key.slice('laborRate_'.length)] = rate > 0 ? Math.round(rate * 100) / 100 : 0;
  }
  return {
    ...current,
    id: 'pricing',
    enabled: values.matrixEnabled === 'on',
    partsMatrix: parseMatrixText(values.partsMatrix),
    minPartsMarginPercent: Math.min(90, Math.max(0, Number(values.minPartsMarginPercent) || 0)),
    laborRates: { ...(current.laborRates || {}), ...laborRates },
  };
}

/** Line fields the work-order editor has no inputs for but must keep on save. */
export const EDITOR_CARRY_FIELDS = Object.freeze(['cost', 'unitCost', 'partstech', 'partstechOrder', 'priceSource', 'source', 'laborGuide', 'inspectionStatus', 'inspectionItemId', 'photoKeys', 'videoKeys', 'mediaKeys', 'laborCategory']);

export function editorCarryFields(line = {}) {
  return Object.fromEntries(EDITOR_CARRY_FIELDS.filter(key => line[key] !== undefined && line[key] !== null && line[key] !== '').map(key => [key, line[key]]));
}
