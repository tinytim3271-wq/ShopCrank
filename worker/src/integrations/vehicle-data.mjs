import { HttpError, json, requestJson } from '../http.mjs';
import { validateProviderBaseUrl } from './labor.mjs';

/**
 * Licensed vehicle data behind Worker config:
 *  - Plate → VIN: any provider that takes { plate, state } and returns a VIN
 *    (CARFAX for Shops Quick VIN, PlateToVIN, etc.). PLATE_TO_VIN_* env vars.
 *  - CARFAX service history by VIN: CARFAX_* env vars from the CARFAX for Shops
 *    partner agreement.
 * The VIN returned by a plate lookup is decoded with NHTSA vPIC (free, public)
 * so year/make/model/engine fill in without another license.
 * Every lookup fails closed with a clear message when not configured.
 */

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));
const TIMEOUT_MS = 10_000;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function providerConfig(env, prefix, defaults = {}) {
  const baseUrl = text(env[`${prefix}_BASE_URL`] || env[`${prefix}_API_BASE_URL`], 500);
  const apiKey = text(env[`${prefix}_API_KEY`], 500);
  return {
    baseUrl,
    path: text(env[`${prefix}_PATH`] || env[`${prefix}_SERVICE_HISTORY_PATH`] || defaults.path || '', 500),
    apiKey,
    authHeader: text(env[`${prefix}_AUTH_HEADER`] || 'Authorization', 80),
    authScheme: text(env[`${prefix}_AUTH_SCHEME`] ?? 'Bearer', 40),
    partnerId: text(env[`${prefix}_PARTNER_ID`], 200),
    method: text(env[`${prefix}_METHOD`] || defaults.method || 'GET', 8).toUpperCase(),
    configured: Boolean(baseUrl && apiKey && (env[`${prefix}_PATH`] || env[`${prefix}_SERVICE_HISTORY_PATH`] || defaults.path)),
  };
}

export function plateToVinConfig(env = {}) {
  return providerConfig(env, 'PLATE_TO_VIN', { method: 'POST', path: '/' });
}

export function carfaxConfig(env = {}) {
  return providerConfig(env, 'CARFAX', {});
}

export function vehicleDataStatus(env = {}) {
  return { plateToVin: plateToVinConfig(env).configured, carfax: carfaxConfig(env).configured, vinDecode: true };
}

function headers(config) {
  const out = { Accept: 'application/json' };
  out[config.authHeader] = config.authScheme ? `${config.authScheme} ${config.apiKey}` : config.apiKey;
  if (config.partnerId) out['X-Partner-Id'] = config.partnerId;
  return out;
}

function endpoint(config, replacements, label) {
  const base = validateProviderBaseUrl(config.baseUrl, `${label} base URL`);
  let path = config.path;
  for (const [key, value] of Object.entries(replacements)) path = path.replaceAll(`{${key}}`, encodeURIComponent(value));
  const url = new URL(path.replace(/^\/+/, ''), `${base.toString().replace(/\/?$/, '/')}`);
  if (url.origin !== base.origin) throw new TypeError(`${label} path must be relative to its base URL`);
  return url;
}

async function callProvider(config, url, { method, body, fetcher, label }) {
  let response;
  try {
    response = await fetcher(url, {
      method,
      headers: { ...headers(config), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new HttpError(502, `${label} request failed: ${error.message || 'network error'}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError(502, `${label} returned HTTP ${response.status}`);
  return response.json().catch(() => {
    throw new HttpError(502, `${label} response was not valid JSON`);
  });
}

function findVin(payload) {
  const candidates = [payload?.vin, payload?.VIN, payload?.data?.vin, payload?.result?.vin, payload?.vehicle?.vin, payload?.vin?.vin, payload?.results?.[0]?.vin, payload?.data?.[0]?.vin];
  return candidates.map(value => text(typeof value === 'object' ? value?.vin : value, 17).toUpperCase()).find(value => VIN.test(value)) || '';
}

export async function decodeVinNhtsa(vin, { fetcher = fetch } = {}) {
  const value = text(vin, 17).toUpperCase();
  if (!VIN.test(value)) throw new HttpError(400, 'A valid 17-character VIN is required');
  try {
    const response = await fetcher(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${value}?format=json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { vin: value };
    const row = (await response.json())?.Results?.[0] || {};
    const engine = [row.DisplacementL ? `${Number(row.DisplacementL).toFixed(1)}L` : '', row.EngineCylinders ? `${row.EngineCylinders}-cyl` : '', row.FuelTypePrimary && row.FuelTypePrimary !== 'Gasoline' ? row.FuelTypePrimary : ''].filter(Boolean).join(' ');
    return { vin: value, year: text(row.ModelYear, 4), make: text(row.Make, 60), model: text(row.Model, 80), trim: text(row.Trim || row.Series, 80), engine, driveType: text(row.DriveType, 60), bodyClass: text(row.BodyClass, 80) };
  } catch {
    return { vin: value };
  }
}

export async function lookupPlate(env, { plate, state }, { fetcher = fetch } = {}) {
  const normalizedPlate = text(plate, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const normalizedState = text(state, 2).toUpperCase();
  if (normalizedPlate.length < 2) throw new HttpError(400, 'Enter the license plate');
  if (!STATES.has(normalizedState)) throw new HttpError(400, 'Choose the plate state');
  const config = plateToVinConfig(env);
  if (!config.configured) throw new HttpError(501, 'Plate-to-VIN lookup is not connected yet. Enter the VIN, or ask ShopCrank to enable a plate lookup provider.');
  const url = endpoint(config, { plate: normalizedPlate, state: normalizedState }, 'Plate lookup');
  if (config.method === 'GET') {
    if (!config.path.includes('{plate}')) url.searchParams.set('plate', normalizedPlate);
    if (!config.path.includes('{state}')) url.searchParams.set('state', normalizedState);
  }
  const payload = await callProvider(config, url, { method: config.method, body: config.method === 'GET' ? null : { plate: normalizedPlate, state: normalizedState }, fetcher, label: 'Plate lookup' });
  const vin = findVin(payload);
  if (!vin) return { found: false, plate: normalizedPlate, state: normalizedState };
  return { found: true, plate: normalizedPlate, state: normalizedState, ...(await decodeVinNhtsa(vin, { fetcher })), source: 'plate_lookup' };
}

function recordList(payload) {
  const candidates = [payload?.serviceRecords, payload?.records, payload?.serviceHistory, payload?.history, payload?.displayRecords, payload?.data?.serviceRecords, payload?.data?.records, payload?.data, payload];
  return candidates.find(Array.isArray) || [];
}

export function normalizeServiceRecord(record = {}) {
  const services = Array.isArray(record.services) ? record.services : Array.isArray(record.text) ? record.text : Array.isArray(record.details) ? record.details : [];
  const description = text(record.description || record.serviceDescription || services.map(item => (typeof item === 'string' ? item : item?.text || item?.description || '')).filter(Boolean).join('; '), 600);
  const odometer = Number(String(record.odometer ?? record.odometerReading ?? record.mileage ?? '').replace(/[^0-9.]/g, ''));
  const date = text(record.date || record.serviceDate || record.displayDate || record.eventDate, 30);
  if (!date && !description) return null;
  return { date, odometer: Number.isFinite(odometer) && odometer > 0 ? odometer : null, description, source: text(record.source || record.facility || record.dealerName || record.serviceProvider || '', 160) };
}

export async function carfaxServiceHistory(env, { vin }, { fetcher = fetch } = {}) {
  const value = text(vin, 17).toUpperCase();
  if (!VIN.test(value)) throw new HttpError(400, 'A valid 17-character VIN is required');
  const config = carfaxConfig(env);
  if (!config.configured) throw new HttpError(501, 'CARFAX service history is not connected yet. ShopCrank needs a CARFAX for Shops partner key to turn it on.');
  const url = endpoint(config, { vin: value }, 'CARFAX');
  if (!config.path.includes('{vin}')) url.searchParams.set('vin', value);
  const payload = await callProvider(config, url, { method: 'GET', fetcher, label: 'CARFAX' });
  const records = recordList(payload).map(normalizeServiceRecord).filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { vin: value, provider: 'carfax', found: records.length > 0, records: records.slice(0, 100), retrievedAt: new Date().toISOString() };
}

export async function handleVehicleData(request, env, context, segments, { requireRole, recordAudit = null } = {}) {
  requireRole(context, ['owner', 'admin', 'office', 'service_writer', 'technician']);
  const action = segments[1] || '';
  const fetcher = env.fetch || fetch;
  if (action === 'status' && request.method === 'GET') return json(vehicleDataStatus(env));
  if (action === 'decode-vin' && request.method === 'GET') {
    return json(await decodeVinNhtsa(new URL(request.url).searchParams.get('vin'), { fetcher }));
  }
  if (action === 'plate-lookup' && request.method === 'POST') {
    const result = await lookupPlate(env, await requestJson(request), { fetcher });
    await recordAudit?.(env, context, { kind: 'vehicles.plate_lookup', found: result.found, state: result.state });
    return json(result);
  }
  if (action === 'service-history' && request.method === 'POST') {
    const result = await carfaxServiceHistory(env, await requestJson(request), { fetcher });
    await recordAudit?.(env, context, { kind: 'vehicles.carfax_history', vin: result.vin, count: result.records.length });
    return json(result);
  }
  throw new HttpError(404, 'Not found');
}
