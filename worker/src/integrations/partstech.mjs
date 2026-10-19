import {
  PARTSTECH_API_BASE,
  PARTSTECH_SECRET_NAME,
  buildPartstechOrderRequest,
  mapPartstechOrderSummary,
  mapPartstechQuoteItemToEstimateLine,
  partstechConnectionStatus,
} from '../../../src/modules/partstech.js';
import { HttpError, json, requestJson } from '../http.mjs';

export function partstechSearchParams(keyword, vin = '') {
  const term = String(keyword || '').trim();
  const looksLikePartNumber = term.length <= 40 && !/\s/.test(term) && /\d/.test(term);
  const params = looksLikePartNumber ? { partNumber: term } : { keyword: term };
  const cleanVin = String(vin || '').trim().toUpperCase();
  if (cleanVin) params.vin = cleanVin;
  return params;
}

function safeRedirectUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /(^|\.)partstech\.com$/i.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const ADMIN_ROLES = ['owner', 'admin', 'super_admin'];
const USE_ROLES = ['owner', 'admin', 'service_writer', 'technician'];

async function readCredentials(getSecret, shopId) {
  const raw = await getSecret(shopId, PARTSTECH_SECRET_NAME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function accessToken(credentials, { fetcher = fetch, baseUrl = PARTSTECH_API_BASE } = {}) {
  if (!credentials?.userId || !credentials?.userKey || !credentials?.partnerId || !credentials?.partnerKey) {
    const error = new HttpError(409, 'PartsTech is not connected');
    error.code = 'not_connected';
    throw error;
  }
  const response = await fetcher(`${baseUrl}/oauth/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      accessType: 'user',
      credentials: {
        user: { id: credentials.userId, key: credentials.userKey },
        partner: { id: credentials.partnerId, key: credentials.partnerKey },
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.accessToken) {
    throw new HttpError(502, body.message || body.error || 'PartsTech authentication failed');
  }
  return body.accessToken;
}

async function partstechFetch(credentials, path, { method = 'GET', body, fetcher = fetch, baseUrl = PARTSTECH_API_BASE } = {}) {
  const token = await accessToken(credentials, { fetcher, baseUrl });
  const response = await fetcher(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status === 401 ? 502 : 502, payload.message || payload.error || `PartsTech request failed (${response.status})`);
  }
  return payload;
}

export function createPartstechHandlers({
  saveSecret,
  getSecret,
  deleteSecret,
  requireRole,
  recordAudit,
}) {
  return async function handlePartstech(request, env, context, segments) {
    const action = segments[2] || '';
    if (request.method === 'GET' && !action) {
      requireRole(context, USE_ROLES);
      const credentials = await readCredentials(getSecret, context.shopId);
      return json(partstechConnectionStatus(credentials));
    }

    if (request.method === 'POST' && !action) {
      requireRole(context, ADMIN_ROLES);
      const body = await requestJson(request);
      const record = {
        partnerId: String(body.partnerId || '').trim(),
        partnerKey: String(body.partnerKey || '').trim(),
        userId: String(body.userId || '').trim(),
        userKey: String(body.userKey || '').trim(),
        storeId: String(body.storeId || '').trim() || null,
        connectedAt: new Date().toISOString(),
        connectedBy: context.userId,
      };
      if (!record.partnerId || !record.partnerKey || !record.userId || !record.userKey) {
        throw new HttpError(400, 'PartsTech partner and user credentials are required');
      }
      await saveSecret(env, context.shopId, PARTSTECH_SECRET_NAME, JSON.stringify(record));
      await recordAudit?.(env, context, { kind: 'integrations.partstech.connect', partnerId: record.partnerId, userId: record.userId });
      return json(partstechConnectionStatus(record), 201);
    }

    if (request.method === 'DELETE' && !action) {
      requireRole(context, ADMIN_ROLES);
      await deleteSecret(env, context.shopId, PARTSTECH_SECRET_NAME);
      await recordAudit?.(env, context, { kind: 'integrations.partstech.disconnect' });
      return json({ connected: false, status: 'not_connected' });
    }

    const credentials = await readCredentials(getSecret, context.shopId);
    if (!partstechConnectionStatus(credentials).connected) {
      throw new HttpError(409, 'PartsTech is not connected');
    }

    requireRole(context, USE_ROLES);
    const fetcher = env.fetch || fetch;
    const baseUrl = env.PARTSTECH_API_BASE || PARTSTECH_API_BASE;

    if (action === 'quote' && request.method === 'POST') {
      const body = await requestJson(request);
      const keyword = String(body.keyword || body.partNumber || '').trim();
      const vin = String(body.vin || '').trim();
      const storeId = String(body.storeId || credentials.storeId || '').trim();
      if (!keyword) throw new HttpError(400, 'keyword or partNumber is required');
      if (!storeId) throw new HttpError(400, 'storeId is required for PartsTech quotes');
      const searchParams = partstechSearchParams(keyword, vin);
      const payload = await partstechFetch(credentials, '/catalog/quote', {
        method: 'POST',
        body: { storeId, searchParams },
        fetcher,
        baseUrl,
      });
      const rawItems = payload.parts || payload.items || payload.quotes || payload.results || [];
      const markupPercent = Math.min(500, Math.max(0, Number(body.markupPercent) || 0));
      const items = (Array.isArray(rawItems) ? rawItems : []).map((item, index) => (
        mapPartstechQuoteItemToEstimateLine({ ...item, storeId, quoteId: payload.quoteId || payload.id }, index, { markupPercent })
      ));
      const unpriced = items.filter(item => item.priceStatus === 'pending').length;
      await recordAudit?.(env, context, { kind: 'integrations.partstech.quote', keyword, storeId, count: items.length, unpriced });
      return json({ connected: true, storeId, items, rawCount: items.length, unpriced });
    }

    if (action === 'order' && !segments[3] && request.method === 'POST') {
      const body = await requestJson(request);
      if (body.sessionId) throw new HttpError(400, 'Use POST /integrations/partstech/order/status to check a PartsTech session');
      let orderRequest;
      try {
        orderRequest = buildPartstechOrderRequest({
          storeId: body.storeId || credentials.storeId,
          lines: body.lines,
          vin: body.vin,
          poNumber: body.poNumber || body.repairOrderId,
          callbackUrl: body.callbackUrl,
        });
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      const payload = await partstechFetch(credentials, '/punchout/quote/create', {
        method: 'POST',
        body: orderRequest,
        fetcher,
        baseUrl,
      });
      const sessionId = payload.sessionId || payload.id || null;
      const redirectUrl = safeRedirectUrl(payload.redirectUrl || payload.url);
      if (!sessionId || !redirectUrl) throw new HttpError(502, 'PartsTech did not return a checkout session');
      await recordAudit?.(env, context, {
        kind: 'integrations.partstech.order_session',
        storeId: orderRequest.storeId,
        repairOrderId: String(body.repairOrderId || '').slice(0, 60) || undefined,
        lineCount: orderRequest.parts.length,
        sessionId,
      });
      return json({ connected: true, status: 'checkout_pending', sessionId, redirectUrl, parts: orderRequest.parts }, 201);
    }

    if (action === 'order' && segments[3] === 'status' && request.method === 'POST') {
      const body = await requestJson(request);
      const sessionId = String(body.sessionId || '').trim();
      if (!/^[\w-]{4,200}$/.test(sessionId)) throw new HttpError(400, 'A PartsTech sessionId is required');
      const payload = await partstechFetch(credentials, '/punchout/quote/info', {
        method: 'POST',
        body: { sessionId },
        fetcher,
        baseUrl,
      });
      const summary = mapPartstechOrderSummary(payload);
      await recordAudit?.(env, context, { kind: 'integrations.partstech.order_status', sessionId, orderId: summary.orderId || undefined, status: summary.status });
      return json({ connected: true, sessionId, order: summary });
    }

    throw new HttpError(404, 'Not found');
  };
}

export { accessToken, partstechFetch, readCredentials };
