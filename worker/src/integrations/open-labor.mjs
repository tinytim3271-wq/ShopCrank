// Open Labor Project (openlaborproject.com) labor times.
//
// Platform key: Worker secret OPEN_LABOR_API_KEY (x-api-key header).
// Times are a reference, not licensed book time: most rows are "estimated"
// (AI-derived) and only "high" confidence rows are checked against OEM or
// Mitchell/Motor data, so only those are marked verified.
//
// The free key allows 7 requests a day and unlocks hours for one job per call,
// so a lookup is: the vehicle's job catalog (cached 30 days) to find the job's
// slug, then `job=<slug>` for its hours (cached 30 days).

import { decodeVinNhtsa } from './vehicle-data.mjs';

const API_BASE = 'https://openlaborproject.com/api/v1/labor-times';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;
export const OPEN_LABOR_SOURCE = 'Open Labor Project';
export const OPEN_LABOR_LABEL = 'Open Labor Project — not book time';

export class OpenLaborError extends Error {
  constructor(message, { status = 502, code = 'open_labor_error' } = {}) {
    super(message);
    this.name = 'OpenLaborError';
    this.status = status;
    this.code = code;
  }
}

export function openLaborConfigured(env = {}) {
  return Boolean(String(env.OPEN_LABOR_API_KEY || '').trim());
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'with', 'on', 'in', 'r', 'rr', 'replace', 'replacement', 'remove', 'install', 'new', 'job', 'labor', 'service', 'repair', 'check', 'both', 'side', 'sides', 'set']);
// Shop shorthand → the words the catalog uses.
const SYNONYMS = Object.freeze({
  aircon: 'ac', tstat: 'thermostat', halfshaft: 'axle', frt: 'front',
  diag: 'diagnosis', diagnose: 'diagnosis', diagnostic: 'diagnosis', diagnostics: 'diagnosis',
});

function words(text) {
  return String(text || '').toLowerCase().replace(/a\/c/g, 'ac').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function stem(word) {
  const mapped = SYNONYMS[word] || word;
  return mapped.length > 3 && mapped.endsWith('s') && !mapped.endsWith('ss') ? mapped.slice(0, -1) : mapped;
}

function tokens(text) {
  return [...new Set(words(text).filter(word => !STOP_WORDS.has(word)).map(stem))];
}

// Position words narrow a job but never identify one on their own.
const QUALIFIERS = new Set(['front', 'rear', 'left', 'right', 'upper', 'lower', 'inner', 'outer', 'pair', 'upstream', 'downstream', 'driver', 'passenger', 'lh', 'rh']);
const BRAKE_PARTS = ['pad', 'rotor', 'drum', 'shoe', 'caliper', 'line', 'fluid', 'hose', 'master', 'booster', 'abs', 'bleed', 'flush', 'light', 'switch', 'parking'];

/** Best catalog job for a free-text operation ("front brake pads", "replace AC compressor"), or null. */
export function matchOpenLaborJob(query, jobs = []) {
  const slug = String(query || '').trim().toLowerCase();
  const exact = jobs.find(job => job.jobSlug === slug);
  if (exact) return exact;
  const wanted = tokens(query);
  // "Front brakes" in a shop means pads.
  if (wanted.includes('brake') && !wanted.some(word => BRAKE_PARTS.includes(word))) wanted.push('pad');
  const content = wanted.filter(word => !QUALIFIERS.has(word));
  if (!content.length) return null;
  const allowedMisses = content.length >= 3 ? 1 : 0;
  let best = null;
  for (const job of jobs) {
    const have = new Set([...tokens(job.job), ...tokens(String(job.jobSlug || '').replace(/-/g, ' '))]);
    if (wanted.some(word => QUALIFIERS.has(word) && !have.has(word))) continue;
    const contentHits = content.filter(word => have.has(word)).length;
    // Every job word named by the shop ("starter motor" → Starter) also counts as a match.
    const fullyNamed = contentHits > 0 && [...have].every(word => wanted.includes(word) || QUALIFIERS.has(word));
    if (content.length - contentHits > allowedMisses && !fullyNamed) continue;
    const hits = wanted.filter(word => have.has(word)).length;
    // Cover the shop's words first, then prefer the job with the fewest extra words.
    const score = hits / wanted.length + hits / Math.max(have.size, 1) * 0.5;
    if (!best || score > best.score || (score === best.score && job.job.length < best.job.job.length)) best = { job, score };
  }
  return best ? best.job : null;
}

/** "2018 Toyota Camry SE" → { year, make, model } (model = the next word; multi-word models need the Model field). */
export function parseVehicleText(text = '') {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  const yearIndex = parts.findIndex(part => /^(19|20)\d{2}$/.test(part));
  if (yearIndex < 0 || parts.length < yearIndex + 3) return {};
  return { year: parts[yearIndex], make: parts[yearIndex + 1], model: parts[yearIndex + 2] };
}

function engineMatches(engine, wanted) {
  const want = String(wanted || '').toLowerCase();
  if (!want) return true;
  const have = String(engine.engine || '').toLowerCase();
  const displacement = want.match(/(\d\.\d)\s*l?/)?.[1];
  if (displacement && !have.includes(`${displacement}l`)) return false;
  return /hybrid/.test(want) ? /hybrid/.test(have) : true;
}

async function cacheGet(env, key) {
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT value_json, expires_at FROM labor_reference_cache WHERE cache_key = ?').bind(key).first();
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

async function cachePut(env, key, value) {
  if (!env?.DB) return;
  try {
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO labor_reference_cache (cache_key, value_json, expires_at, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at, created_at = excluded.created_at
    `).bind(key, JSON.stringify(value), new Date(now + CACHE_TTL_MS).toISOString(), new Date(now).toISOString()).run();
  } catch {
    // Cache is an optimization; a failed write only costs a request next time.
  }
}

async function callApi(env, params, fetcher, endpoint = API_BASE) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetcher(url.toString(), {
      headers: { Accept: 'application/json', 'x-api-key': String(env.OPEN_LABOR_API_KEY).trim() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new OpenLaborError(`Open Labor Project could not be reached: ${error.message}`);
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 429) {
    throw new OpenLaborError('Open Labor Project request limit reached for today. A paid key raises it.', { status: 429, code: 'rate_limited' });
  }
  if (response.status === 401 || response.status === 403) {
    throw new OpenLaborError('Open Labor Project rejected the API key', { status: 502, code: 'bad_key' });
  }
  if (response.status === 404) return { engines: [] };
  if (!response.ok || !payload) {
    throw new OpenLaborError(payload?.error?.message || `Open Labor Project returned HTTP ${response.status}`);
  }
  return { engines: Array.isArray(payload.data?.engines) ? payload.data.engines : [], data: payload.data, meta: payload.meta };
}

const SPEC_ENDPOINTS = Object.freeze({
  torque: 'torque-specs',
  fluids: 'fluid-specs',
  dtc: 'dtc-codes',
  battery: 'battery-specs',
});

function trimLocked(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => trimLocked(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, trimLocked(item, depth + 1)]));
}

/**
 * Repair reference data from Open Labor Project: torque specs, fluid types and
 * capacities, trouble-code meanings, or battery specs for a vehicle.
 * Cached 30 days like labor times. Values are references, not OEM service data.
 */
export async function lookupRepairSpecs(env, { kind, year, make, model, engine = '', job = '', code = '' } = {}, { fetcher = fetch } = {}) {
  if (!openLaborConfigured(env)) return { error: 'Open Labor Project is not connected (OPEN_LABOR_API_KEY). Use search_web for specs, and say they need verifying.' };
  const endpoint = SPEC_ENDPOINTS[String(kind || '').toLowerCase()];
  if (!endpoint) return { error: 'kind must be torque, fluids, dtc or battery.' };
  const dtcOnly = endpoint === 'dtc-codes' && code && !(year && make && model);
  if (!dtcOnly && !(year && make && model)) return { error: 'Year, make and model are required.' };
  const params = dtcOnly ? { code } : { make, model, year, engine, job: endpoint === 'torque-specs' ? job : '', code: endpoint === 'dtc-codes' ? code : '', region: 'US' };
  const key = `openlabor:${endpoint}:${Object.values(params).map(value => String(value || '').toLowerCase()).join('|')}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;
  const reply = await callApi(env, params, fetcher, API_BASE.replace('labor-times', endpoint));
  const result = {
    kind,
    source: OPEN_LABOR_SOURCE,
    note: 'Reference data, not OEM service information: confirm critical values (torque, capacities) in the service manual.',
    data: trimLocked(reply.data),
    ...(reply.meta?.freeTier?.message ? { limitedByFreeKey: true } : {}),
  };
  if (reply.data) await cachePut(env, key, result);
  return result;
}

function vehicleKey({ year, make, model }) {
  return [year, make, model].map(value => String(value || '').trim().toLowerCase().replace(/\s+/g, '-')).join('|');
}

function hasHours(row) {
  return row && !row.locked && Number.isFinite(Number(row.hours)) && Number(row.hours) > 0;
}

/**
 * Labor time for one operation on one vehicle. Returns one result per matching
 * engine, best engine match first: { hours, lowRange, highRange, confidence,
 * verified, description, engine, job, jobSlug, source, provider }. [] = no match.
 */
export async function searchOpenLabor(env, input = {}, { fetcher = fetch } = {}) {
  if (!openLaborConfigured(env)) return [];
  // The estimate editor sends one vehicle string ("2018 Toyota Camry") in `model`.
  const structured = Boolean(input.year || input.make);
  const parsed = parseVehicleText(input.vehicle || (structured ? '' : input.model));
  let year = input.year || parsed.year;
  let make = input.make || parsed.make;
  let model = structured ? input.model || parsed.model : parsed.model || input.model;
  let engine = input.engine;
  if (!(year && make && model && engine) && /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(input.vin || ''))) {
    const decoded = await decodeVinNhtsa(input.vin, { fetcher });
    year = year || decoded.year;
    make = make || decoded.make;
    model = model || decoded.model;
    engine = engine || decoded.engine;
  }
  const query = String(input.query || input.keyword || input.operation || '').trim();
  if (!year || !make || !model || !query) return [];
  const vehicle = { year: String(year).trim(), make: String(make).trim(), model: String(model).trim() };
  const base = vehicleKey(vehicle);

  let catalog = await cacheGet(env, `openlabor:catalog:${base}`);
  if (!catalog) {
    const { engines } = await callApi(env, { ...vehicle, region: 'US' }, fetcher);
    catalog = engines.map(engine => ({
      engine: engine.engine,
      engineSlug: engine.engineSlug,
      jobs: (engine.laborTimes || []).map(row => ({ job: row.job, jobSlug: row.jobSlug, category: row.category, ...(hasHours(row) ? { hours: row.hours, lowRange: row.lowRange, highRange: row.highRange, confidence: row.confidence } : {}) })),
    }));
    if (catalog.length) await cachePut(env, `openlabor:catalog:${base}`, catalog);
  }
  if (!catalog.length) return [];
  const allJobs = [...new Map(catalog.flatMap(engine => engine.jobs).map(job => [job.jobSlug, job])).values()];
  const job = matchOpenLaborJob(query, allJobs);
  if (!job) return [];

  let rows = await cacheGet(env, `openlabor:job:${base}|${job.jobSlug}`);
  if (!rows) {
    // The catalog call may already have unlocked this job (paid keys unlock all of them).
    const fromCatalog = catalog.map(engine => ({ engine: engine.engine, row: engine.jobs.find(item => item.jobSlug === job.jobSlug) }));
    if (fromCatalog.every(item => hasHours(item.row))) {
      rows = fromCatalog.map(({ engine, row }) => ({ engine, ...row }));
    } else {
      const { engines } = await callApi(env, { ...vehicle, job: job.jobSlug, region: 'US' }, fetcher);
      rows = engines.flatMap(engine => (engine.laborTimes || []).filter(hasHours).map(row => ({ engine: engine.engine, job: row.job, jobSlug: row.jobSlug, hours: row.hours, lowRange: row.lowRange, highRange: row.highRange, confidence: row.confidence })));
    }
    if (rows.length) await cachePut(env, `openlabor:job:${base}|${job.jobSlug}`, rows);
  }

  return rows
    .map(row => ({ row, match: engineMatches(row, engine) }))
    .sort((a, b) => Number(b.match) - Number(a.match))
    .filter(item => item.match)
    .map(({ row }) => {
      const confidence = String(row.confidence || 'estimated');
      const verified = confidence === 'high';
      const confidenceLabel = verified ? 'high confidence' : confidence;
      const range = row.lowRange != null && row.highRange != null ? `${row.lowRange}–${row.highRange} h` : 'unavailable';
      return {
        hours: Number(row.hours),
        lowRange: row.lowRange ?? null,
        highRange: row.highRange ?? null,
        confidence,
        verified,
        job: row.job,
        jobSlug: row.jobSlug,
        engine: row.engine,
        description: `${row.job}${catalog.length > 1 ? ` (${row.engine})` : ''}`,
        source: `${OPEN_LABOR_LABEL} (${confidenceLabel}, range ${range})`,
        provider: OPEN_LABOR_SOURCE,
        bookTime: false,
      };
    });
}
