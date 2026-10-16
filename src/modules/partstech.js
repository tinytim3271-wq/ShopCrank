/** PartsTech parts search/quote/order helpers for estimate and RO screens. */

export const PARTSTECH_API_BASE = 'https://api.partstech.com';
export const PARTSTECH_SECRET_NAME = 'partstech-credentials';

const MAX_ORDER_LINES = 50;
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

export function partstechConnectionStatus(record) {
  if (!record || typeof record !== 'object') {
    return { connected: false, status: 'not_connected', label: 'PartsTech not connected' };
  }
  const hasUser = Boolean(record.userId && record.userKey);
  const hasPartner = Boolean(record.partnerId && record.partnerKey);
  if (!hasUser || !hasPartner) {
    return { connected: false, status: 'not_connected', label: 'PartsTech not connected' };
  }
  return {
    connected: true,
    status: 'connected',
    label: 'PartsTech connected',
    userId: record.userId,
    partnerId: record.partnerId,
    storeId: record.storeId || null,
    connectedAt: record.connectedAt || null,
  };
}

/** Parses 42.5, "42.50", "$1,042.50", or { amount } into a positive number, else null. */
export function parsePartstechMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return parsePartstechMoney(value.amount ?? value.value);
  const number = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(number) && number > 0 ? roundMoney(number) : null;
}

function firstMoney(...candidates) {
  for (const candidate of candidates) {
    const parsed = parsePartstechMoney(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value.name ?? value.displayName ?? value.title ?? value.id ?? '').trim();
  return String(value).trim();
}

/**
 * PartsTech returns price as an object ({ list, cost, core, ... }) on quotes,
 * sometimes as flat fields. The customer-facing price is list/retail; cost is
 * the shop's buy price and is only used (with the shop markup) when no list
 * price is supplied.
 */
export function partstechPricing(item = {}, { markupPercent = 0 } = {}) {
  const price = item.price && typeof item.price === 'object' ? item.price : {};
  const flatPrice = typeof item.price === 'object' ? null : item.price;
  const list = firstMoney(
    price.customerPrice, price.retail, price.retailPrice, price.list, price.listPrice,
    item.customerPrice, item.retailPrice, item.listPrice, item.list, flatPrice, item.unitPrice,
  );
  const cost = firstMoney(price.cost, price.net, price.yourPrice, item.cost, item.netPrice);
  const core = firstMoney(price.core, price.coreCharge, item.core, item.coreCharge, item.corePrice);
  const markup = Math.max(0, Number(markupPercent) || 0);
  if (list !== null) return { unitPrice: list, cost, core, priceBasis: 'list', priceStatus: 'priced' };
  if (cost !== null) {
    return { unitPrice: roundMoney(cost * (1 + markup / 100)), cost, core, priceBasis: markup ? 'cost_markup' : 'cost', priceStatus: 'priced' };
  }
  return { unitPrice: 0, cost: null, core, priceBasis: 'none', priceStatus: 'pending' };
}

function availabilitySummary(value) {
  if (Array.isArray(value)) {
    const locations = value.map(entry => ({
      name: textOf(entry?.name ?? entry?.location ?? entry?.type),
      quantity: Math.max(0, Number(entry?.quantity ?? entry?.qty) || 0),
    }));
    return {
      quantity: locations.reduce((sum, entry) => sum + entry.quantity, 0),
      label: locations.filter(entry => entry.quantity > 0).map(entry => `${entry.quantity} @ ${entry.name || 'store'}`).join(', ') || 'Out of stock',
    };
  }
  if (value && typeof value === 'object') return availabilitySummary([value]);
  if (value === null || value === undefined || value === '') return null;
  return { quantity: Number(value) || 0, label: String(value) };
}

export function mapPartstechQuoteItemToEstimateLine(item = {}, index = 0, options = {}) {
  const quantity = Math.max(1, Math.trunc(Number(item.quantity ?? item.qty ?? 1) || 1));
  const pricing = partstechPricing(item, options);
  const partNumber = textOf(item.partNumber || item.part_number || item.sku || item.brandPartNumber);
  const brand = textOf(item.brand || item.brandName || item.manufacturer);
  const name = textOf(item.description || item.partName || item.name || item.title || item.partType);
  const description = [brand, name].filter(Boolean).join(' ') || [brand, partNumber].filter(Boolean).join(' ') || 'Part';
  return {
    id: String(item.lineId || item.partId || item.id || `pt-part-${index + 1}`),
    type: 'part',
    description,
    partNumber,
    quantity,
    unitPrice: pricing.unitPrice,
    hours: 0,
    laborRate: 0,
    total: roundMoney(quantity * pricing.unitPrice),
    priceStatus: pricing.priceStatus,
    approvalStatus: 'pending',
    source: 'partstech',
    partstech: {
      partId: item.partId || item.id || null,
      partNumber,
      brand: brand || null,
      lineCardId: item.lineCardId ?? item.brand?.lineCardId ?? null,
      partTypeId: item.partTypeId ?? item.partType?.id ?? null,
      storeId: item.storeId || null,
      supplier: textOf(item.supplier || item.seller || item.store) || null,
      availability: availabilitySummary(item.availability ?? item.stock),
      quoteId: item.quoteId || null,
      cost: pricing.cost,
      coreCharge: pricing.core,
      priceBasis: pricing.priceBasis,
    },
  };
}

/** Converts a quoted line into the estimate lines it adds: the part, plus a core charge when PartsTech reports one. */
export function partstechLineToEstimateLines(line = {}) {
  const lines = [{ ...line }];
  const core = parsePartstechMoney(line.partstech?.coreCharge);
  if (core) {
    lines.push({
      id: `${line.id}-core`,
      type: 'part',
      description: `Core charge — ${line.description}`,
      partNumber: line.partNumber ? `${line.partNumber}-CORE` : '',
      quantity: line.quantity || 1,
      unitPrice: core,
      total: roundMoney((line.quantity || 1) * core),
      priceStatus: 'priced',
      approvalStatus: 'pending',
      source: 'partstech',
      partstech: { ...line.partstech, isCore: true },
    });
  }
  return lines;
}

function cleanString(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Builds the PartsTech punch-out cart request from repair-order part lines.
 * Only vendor fields are sent; internal estimate fields (totals, approval,
 * technician data) never leave Shop Crank. Throws on invalid input.
 */
export function buildPartstechOrderRequest({ storeId, lines = [], vin = '', poNumber = '', callbackUrl = '' } = {}) {
  const store = cleanString(storeId, 60);
  if (!store) throw new TypeError('storeId is required to order from PartsTech');
  const parts = (Array.isArray(lines) ? lines : [])
    .filter(line => line && line.type !== 'labor' && line.type !== 'fee' && line.approvalStatus !== 'declined' && !line.partstech?.isCore)
    .map(line => {
      const partNumber = cleanString(line.partstech?.partNumber || line.partNumber, 60);
      const quantity = Math.trunc(Number(line.quantity ?? 1));
      if (!partNumber) throw new TypeError(`"${cleanString(line.description, 60) || 'Part'}" needs a part number to order`);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
        throw new TypeError(`Quantity for ${partNumber} must be a whole number from 1 to 999`);
      }
      const part = { partNumber, quantity };
      const brand = cleanString(line.partstech?.brand, 80);
      if (brand) part.brand = brand;
      if (line.partstech?.lineCardId !== null && line.partstech?.lineCardId !== undefined) part.lineCardId = line.partstech.lineCardId;
      if (line.partstech?.partTypeId !== null && line.partstech?.partTypeId !== undefined) part.partTypeId = line.partstech.partTypeId;
      if (line.partstech?.partId) part.partId = String(line.partstech.partId);
      return part;
    });
  if (!parts.length) throw new TypeError('Add at least one priced part line before ordering');
  if (parts.length > MAX_ORDER_LINES) throw new TypeError(`PartsTech orders are limited to ${MAX_ORDER_LINES} lines`);
  const request = { storeId: store, parts };
  const cleanVin = cleanString(vin, 17).toUpperCase();
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(cleanVin)) request.searchParams = { vin: cleanVin };
  const po = cleanString(poNumber, 40);
  if (po) request.poNumber = po;
  if (callbackUrl) {
    const url = new URL(callbackUrl);
    if (url.protocol !== 'https:') throw new TypeError('callbackUrl must use HTTPS');
    request.callbackUrl = url.toString();
  }
  return request;
}

export function mapPartstechOrderSummary(order = {}) {
  const orders = Array.isArray(order.orders) ? order.orders : [];
  const first = orders[0] || order;
  const items = first.items || first.parts || order.items || order.parts;
  return {
    orderId: String(first.orderId || first.id || order.orderId || ''),
    status: String(first.status || first.state || order.status || order.state || 'submitted'),
    total: parsePartstechMoney(first.total ?? first.amount ?? order.total ?? order.amount) || 0,
    storeId: first.storeId || order.storeId || null,
    placedAt: first.placedAt || first.createdAt || order.placedAt || order.createdAt || null,
    poNumber: first.poNumber || order.poNumber || null,
    items: Array.isArray(items) ? items.map((item, index) => mapPartstechQuoteItemToEstimateLine(item, index)) : [],
  };
}

export function partstechQuoteRowHtml(item, { escapeHtml = v => String(v ?? ''), escapeAttr = escapeHtml, money = v => `$${Number(v).toFixed(2)}`, canAdd = true } = {}) {
  const price = item.priceStatus === 'pending' ? '<span class="login-error">Price unavailable</span>' : escapeHtml(money(item.unitPrice));
  const cost = item.partstech?.cost ? `<small>Cost ${escapeHtml(money(item.partstech.cost))}</small>` : '';
  const core = item.partstech?.coreCharge ? `<small>+ core ${escapeHtml(money(item.partstech.coreCharge))}</small>` : '';
  const stock = item.partstech?.availability?.label ? `<small>${escapeHtml(item.partstech.availability.label)}</small>` : '';
  return `<tr><td>${escapeHtml(item.description)}${stock}</td><td>${escapeHtml(item.partNumber)}</td><td>${price}${cost}${core}</td><td><button type="button" class="mini-action" data-add-pt-line="${escapeAttr(item.id)}" ${canAdd ? '' : 'disabled'}>Add to RO</button></td></tr>`;
}

export function partstechPanelHtml(account = {}, { canSave = false, escapeHtml = v => String(v ?? ''), icon = () => '' } = {}) {
  const status = partstechConnectionStatus(account);
  const banner = status.connected
    ? `<div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>User ${escapeHtml(status.userId || '')}${status.storeId ? ` · store ${escapeHtml(status.storeId)}` : ''}</span></div></div>`
    : `<div class="messaging-status idle">${icon('lock', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>Connect PartsTech with partner and user API keys. Search, quote, and order stay server-side; unconfigured shops fail closed.</span></div></div>`;
  const form = canSave
    ? `<form id="partstech-connect-form" class="form-grid">
        <label>Partner ID<input name="partnerId" autocomplete="off" value="${escapeHtml(account.partnerId || '')}" required/></label>
        <label>Partner API key<input name="partnerKey" type="password" autocomplete="new-password" required/></label>
        <label>User ID<input name="userId" autocomplete="off" value="${escapeHtml(account.userId || '')}" required/></label>
        <label>User API key<input name="userKey" type="password" autocomplete="new-password" required/></label>
        <label>Default store ID<input name="storeId" value="${escapeHtml(account.storeId || '')}" placeholder="Optional"/></label>
        <button class="primary" type="submit">${icon('save', 14)} Save PartsTech</button>
        ${status.connected ? `<button class="secondary danger" type="button" id="partstech-disconnect">${icon('log-out', 14)} Disconnect</button>` : ''}
      </form>`
    : '<p class="ops-note">Ask an owner or admin to connect PartsTech.</p>';
  const search = `<form id="partstech-search-form" class="form-grid">
      <label class="full">Keyword or part number<input name="keyword" placeholder="brake pad" ${status.connected ? '' : 'disabled'}/></label>
      <label>VIN<input name="vin" placeholder="Optional VIN" ${status.connected ? '' : 'disabled'}/></label>
      <label>Store ID<input name="storeId" value="${escapeHtml(account.storeId || '')}" ${status.connected ? '' : 'disabled'}/></label>
      <button class="primary" type="submit" ${status.connected ? '' : 'disabled'}>${icon('search', 14)} Quote parts</button>
    </form>
    <div id="partstech-results" class="data-panel"></div>
    <div class="messaging-actions"><button class="secondary" type="button" id="partstech-order-ro" ${status.connected ? '' : 'disabled'}>${icon('shopping-cart', 14)} Order this RO's PartsTech parts</button><button class="secondary" type="button" id="partstech-order-status" ${status.connected ? '' : 'disabled'}>${icon('refresh-cw', 14)} Check order status</button></div>`;
  return `<section class="settings-panel partstech-ordering">
    <div class="statement-head"><div><div class="eyebrow">Parts ordering</div><h2>PartsTech</h2><p>Quote parts through PartsTech, add them to the selected repair order, then send that RO's parts to PartsTech checkout. Credentials are encrypted in D1.</p></div>${icon('package', 20)}</div>
    ${banner}
    ${form}
    ${search}
  </section>`;
}
