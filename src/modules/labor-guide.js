/**
 * Pluggable labor-guide providers. Production paths fail closed when a
 * licensed provider is not connected. Manual entry always works.
 * When no book provider (MOTOR / ALLDATA / ShopKey) is connected, the Worker
 * may return a clearly labeled web average — never as book time.
 */

export const LABOR_GUIDE_SECRET_NAME = 'labor-guide-credentials';
export const LABOR_GUIDE_PROVIDERS = Object.freeze(['manual', 'motor', 'alldata', 'shopkey']);
export const BOOK_LABOR_PROVIDERS = Object.freeze(['motor', 'alldata', 'shopkey']);
export const WEB_ESTIMATE_LABEL = 'web estimate — not book time';

const PROVIDER_LABELS = Object.freeze({
  manual: 'Manual labor entry',
  motor: 'MOTOR labor guide',
  alldata: 'ALLDATA labor guide',
  shopkey: 'ShopKey labor guide',
});

function normalizeProvider(value) {
  const provider = String(value || 'manual').trim().toLowerCase();
  return LABOR_GUIDE_PROVIDERS.includes(provider) ? provider : null;
}

function bookCredentialsReady(provider, record = {}) {
  if (provider === 'motor') {
    return Boolean(
      record.apiKey
      || (record.publicKey && record.privateKey)
      || (record.userId && record.userKey && record.partnerId && record.partnerKey)
      || record.viaPartstech === true,
    );
  }
  if (provider === 'alldata' || provider === 'shopkey') {
    return Boolean(record.apiKey || record.username && record.password || record.subscriptionId);
  }
  return false;
}

export function isBookLaborProvider(provider) {
  return BOOK_LABOR_PROVIDERS.includes(String(provider || '').toLowerCase());
}

export function laborGuideConnectionStatus(record) {
  if (!record || typeof record !== 'object') {
    return {
      connected: false,
      provider: null,
      status: 'not_connected',
      label: 'Labor guide not connected',
      webFallbackEligible: true,
    };
  }
  const provider = normalizeProvider(record.provider) || 'manual';
  if (provider === 'manual') {
    return {
      connected: false,
      provider: 'manual',
      status: 'manual',
      label: PROVIDER_LABELS.manual,
      webFallbackEligible: true,
    };
  }
  if (!isBookLaborProvider(provider)) {
    return {
      connected: false,
      provider: null,
      status: 'not_connected',
      label: 'Labor guide not connected',
      webFallbackEligible: true,
    };
  }
  const ready = bookCredentialsReady(provider, record);
  return ready
    ? {
      connected: true,
      provider,
      status: 'connected',
      label: `${PROVIDER_LABELS[provider]} connected`,
      connectedAt: record.connectedAt || null,
      viaPartstech: provider === 'motor' ? Boolean(record.viaPartstech) : false,
      webFallbackEligible: false,
    }
    : {
      connected: false,
      provider,
      status: 'not_connected',
      label: `${PROVIDER_LABELS[provider]} not connected`,
      webFallbackEligible: true,
    };
}

export function createManualLaborEntry({
  description = 'Labor',
  hours = 0,
  laborRate = 0,
  notes = '',
  id = `labor-manual-${Date.now()}`,
} = {}) {
  const safeHours = Math.max(0, Number(hours) || 0);
  const safeRate = Math.max(0, Number(laborRate) || 0);
  return {
    id: String(id),
    type: 'labor',
    description: String(description || 'Labor'),
    notes: String(notes || ''),
    hours: safeHours,
    laborRate: safeRate,
    quantity: safeHours,
    unitPrice: safeRate,
    total: Math.round(safeHours * safeRate * 100) / 100,
    approvalStatus: 'pending',
    source: 'manual',
    laborGuide: { provider: 'manual' },
  };
}

export function mapMotorLaborOperationToEstimateLine(operation = {}, options = {}, index = 0) {
  const hours = Math.max(0, Number(operation.hours ?? operation.time ?? operation.baseTime ?? 0) || 0);
  const laborRate = Math.max(0, Number(options.laborRate) || 0);
  const description = String(
    operation.description || operation.name || operation.title || operation.operationName || 'Labor operation',
  );
  const provider = String(options.provider || operation.provider || 'motor').toLowerCase();
  return {
    id: String(operation.lineId || operation.operationId || operation.id || `${provider}-labor-${index + 1}`),
    type: 'labor',
    description,
    notes: String(operation.notes || operation.application || ''),
    hours,
    laborRate,
    quantity: hours,
    unitPrice: laborRate,
    total: Math.round(hours * laborRate * 100) / 100,
    approvalStatus: 'pending',
    source: provider,
    laborGuide: {
      provider,
      operationId: operation.operationId || operation.id || null,
      groupId: operation.groupId || null,
      category: operation.category || null,
    },
  };
}

/**
 * Build a labor line from a web average. Always stamped as not book time.
 */
export function mapWebLaborEstimateToEstimateLine(estimate = {}, options = {}, index = 0) {
  const hours = Math.max(0, Number(estimate.averageHours ?? estimate.hours) || 0);
  const laborRate = Math.max(0, Number(options.laborRate) || 0);
  const sources = Array.isArray(estimate.sources) ? estimate.sources.filter(Boolean) : [];
  const description = String(estimate.description || options.description || 'Labor (web estimate)');
  return {
    id: String(estimate.id || `web-labor-${index + 1}`),
    type: 'labor',
    description: `${description} (${WEB_ESTIMATE_LABEL})`,
    notes: WEB_ESTIMATE_LABEL,
    hours,
    laborRate,
    quantity: hours,
    unitPrice: laborRate,
    total: Math.round(hours * laborRate * 100) / 100,
    approvalStatus: 'pending',
    source: 'web_estimate',
    laborGuide: {
      provider: 'web_estimate',
      label: WEB_ESTIMATE_LABEL,
      sourceCount: sources.length || Number(estimate.sourceCount) || 0,
      sources,
      minHours: estimate.minHours ?? null,
      maxHours: estimate.maxHours ?? null,
      notBookTime: true,
    },
  };
}

export function buildLaborWebSearchQuery({
  year, make, model, engine, operation, keyword,
} = {}) {
  const vehicle = [year, make, model, engine].map(part => String(part || '').trim()).filter(Boolean).join(' ');
  const job = String(operation || keyword || '').trim();
  const parts = [vehicle, job, 'labor time hours average mechanic'].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract hour figures from free text snippets. Returns only values that look
 * like labor hours (0.1–40). Never invents values when none are present.
 */
export function extractLaborHoursFromText(text = '') {
  const source = String(text || '');
  const found = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)\b/gi,
    /(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)\b/gi,
    /\b(?:labor|book|flat\s*rate)\s*(?:time|hours?)?\s*[:=]?\s*(\d+(?:\.\d+)?)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[2] != null) {
        const low = Number(match[1]);
        const high = Number(match[2]);
        if (Number.isFinite(low) && Number.isFinite(high)) {
          if (low >= 0.1 && low <= 40) found.push(low);
          if (high >= 0.1 && high <= 40) found.push(high);
        }
      } else if (match[1] != null) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 0.1 && value <= 40) found.push(value);
      }
    }
  }
  return found;
}

export function averageLaborHours(values = []) {
  const nums = values.map(Number).filter(value => Number.isFinite(value) && value >= 0.1 && value <= 40);
  if (!nums.length) return null;
  const sum = nums.reduce((total, value) => total + value, 0);
  const average = Math.round((sum / nums.length) * 10) / 10;
  return {
    averageHours: average,
    minHours: Math.min(...nums),
    maxHours: Math.max(...nums),
    sampleCount: nums.length,
  };
}

export function summarizeWebLaborEstimate({
  description,
  snippets = [],
  sources = [],
} = {}) {
  const hours = extractLaborHoursFromText(snippets.join('\n'));
  const stats = averageLaborHours(hours);
  if (!stats) {
    return {
      found: false,
      label: WEB_ESTIMATE_LABEL,
      message: 'no estimate found',
      sourceCount: 0,
      sources: [],
    };
  }
  const uniqueSources = [];
  const seen = new Set();
  for (const source of sources) {
    const url = typeof source === 'string' ? source : source?.url;
    const title = typeof source === 'string' ? url : (source?.title || url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    uniqueSources.push({ url: String(url), title: String(title || url) });
  }
  return {
    found: true,
    label: WEB_ESTIMATE_LABEL,
    notBookTime: true,
    description: String(description || 'Labor'),
    ...stats,
    sourceCount: uniqueSources.length,
    sources: uniqueSources,
  };
}

/** Provider interface used by the Worker and UI. */
export function createLaborGuideProvider(kind, credentials = {}) {
  const provider = normalizeProvider(kind) || 'manual';
  if (isBookLaborProvider(provider)) {
    return {
      id: provider,
      connected: laborGuideConnectionStatus({ ...credentials, provider }).connected,
      async search() {
        if (!this.connected) {
          const error = new Error(`${PROVIDER_LABELS[provider]} is not connected`);
          error.code = 'not_connected';
          throw error;
        }
        const error = new Error('Use /api/integrations/labor-guide/search on the Worker');
        error.code = 'use_worker';
        throw error;
      },
      toEstimateLine(operation, options, index) {
        return mapMotorLaborOperationToEstimateLine(operation, { ...options, provider }, index);
      },
    };
  }
  return {
    id: 'manual',
    connected: true,
    async search() {
      return { groups: [], operations: [], provider: 'manual' };
    },
    toEstimateLine(entry, options) {
      return createManualLaborEntry({ ...entry, laborRate: entry.laborRate ?? options?.laborRate });
    },
  };
}

const LICENSE_LABELS = Object.freeze({
  partstech: "through the shop's PartsTech account",
  shop: "with the shop's own license",
  platform: "included with ShopCrank",
});

/** Banner shown above book-time results so estimates show where the hours came from. */
export function laborBookTimeBanner(result = {}, escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, '')) {
  if (!result.bookTime) return '';
  const label = result.label || `${PROVIDER_LABELS[result.provider] || 'Labor guide'} book time`;
  const via = LICENSE_LABELS[result.licensedBy] || '';
  return `<div class="messaging-status ready"><div><strong>${escapeHtml(label)}</strong><span>Published book labor times${via ? ` ${escapeHtml(via)}` : ''}.</span></div></div>`;
}

export function laborGuidePanelHtml(account = {}, { canSave = false, escapeHtml = v => String(v ?? ''), icon = () => '' } = {}) {
  // The Worker returns a sanitized status (no keys); recomputing it from that would read as disconnected.
  const status = typeof account.connected === 'boolean' && account.status ? account : laborGuideConnectionStatus(account);
  const platformMotor = !status.connected && account.platform?.motor;
  const banner = status.connected
    ? `<div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>Book times from the connected provider</span></div></div>`
    : platformMotor
    ? `<div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>MOTOR labor guide (included with ShopCrank)</strong><span>Estimates use MOTOR book times. Web averages are only used when MOTOR has no match, and are labeled ${escapeHtml(WEB_ESTIMATE_LABEL)}.</span></div></div>`
    : `<div class="messaging-status idle">${icon('book-open', 17)}<div><strong>${escapeHtml(status.label)}</strong><span>Manual entry always works. With no MOTOR / ALLDATA / ShopKey connection, lookup uses a labeled web average (${escapeHtml(WEB_ESTIMATE_LABEL)}) when search is configured — never as book time.</span></div></div>`;
  const form = canSave
    ? `<form id="labor-guide-connect-form" class="form-grid">
        <label>Provider<select name="provider">
          <option value="motor" ${account.provider === 'motor' ? 'selected' : ''}>MOTOR</option>
          <option value="alldata" ${account.provider === 'alldata' ? 'selected' : ''}>ALLDATA</option>
          <option value="shopkey" ${account.provider === 'shopkey' ? 'selected' : ''}>ShopKey</option>
          <option value="manual" ${!account.provider || account.provider === 'manual' ? 'selected' : ''}>Manual only</option>
        </select></label>
        <label class="toggle-field full"><input type="checkbox" name="viaPartstech" ${account.viaPartstech !== false ? 'checked' : ''}/><span>For MOTOR: use the shop's PartsTech credentials</span></label>
        <label>MOTOR public key<input name="publicKey" autocomplete="off" placeholder="Only when not using PartsTech"/></label>
        <label>MOTOR private key<input name="privateKey" type="password" autocomplete="off"/></label>
        <label>ALLDATA / ShopKey subscription ID<input name="subscriptionId" autocomplete="off"/></label>
        <label>ALLDATA / ShopKey API key<input name="apiKey" type="password" autocomplete="off"/></label>
        <button class="primary" type="submit">${icon('save', 14)} Save labor guide</button>
        ${status.connected ? `<button class="secondary danger" type="button" id="labor-guide-disconnect">${icon('log-out', 14)} Disconnect provider</button>` : ''}
      </form>`
    : '<p class="ops-note">Ask an owner or admin to connect a labor guide.</p>';
  const searchEnabled = true;
  const search = `<form id="labor-guide-search-form" class="form-grid">
      <label class="full">Operation keyword<input name="keyword" placeholder="front brake pads" ${searchEnabled ? '' : 'disabled'}/></label>
      <label>Year<input name="year" placeholder="2022"/></label>
      <label>Make<input name="make" placeholder="Ford"/></label>
      <label>Model<input name="model" placeholder="F-150"/></label>
      <label>Engine<input name="engine" placeholder="5.0L"/></label>
      <label>VIN<input name="vin"/></label>
      <label>Labor rate<input name="laborRate" type="number" step=".01" min="0" value="${escapeHtml(account.defaultLaborRate || '')}"/></label>
      <button class="primary" type="submit">${icon('search', 14)} Look up labor times</button>
    </form>
    <p class="ops-note">Connected book providers return guide times. Otherwise results are labeled <b>${escapeHtml(WEB_ESTIMATE_LABEL)}</b> with source links, or “no estimate found”.</p>
    <form id="manual-labor-form" class="form-grid">
      <label class="full">Manual labor description<input name="description" required placeholder="Diagnose noise"/></label>
      <label>Hours<input name="hours" type="number" step=".1" min="0" value="1" required/></label>
      <label>Rate<input name="laborRate" type="number" step=".01" min="0" value="${escapeHtml(account.defaultLaborRate || '165')}" required/></label>
      <button class="secondary" type="submit">${icon('plus', 14)} Add manual labor line</button>
    </form>
    <div id="labor-guide-results" class="data-panel"></div>`;
  return `<section class="settings-panel labor-guide">
    <div class="statement-head"><div><div class="eyebrow">Labor guide</div><h2>Times &amp; operations</h2><p>Pluggable labor guide: MOTOR, ALLDATA, ShopKey, manual entry, and labeled web fallback when no book provider is connected.</p></div>${icon('timer', 20)}</div>
    ${banner}
    ${form}
    ${search}
  </section>`;
}
