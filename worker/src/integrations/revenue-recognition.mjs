/**
 * Stripe Revenue Recognition general-import CSV builder and S3 upload.
 * Stripe has no public RevRec import API; automation uses the Amazon S3 connector.
 */

const CHARGE_ID = /^ch_[A-Za-z0-9_]+$/;
const PAYMENT_ID = /^py_[A-Za-z0-9_]+$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]+$/;
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
const EXTERNAL_METHODS = new Set(['cash', 'check', 'bank', 'other']);
const CSV_HEADER = [
  'source',
  'transaction_id',
  'split_transaction_id',
  'booked_date',
  'recognition_start_date',
  'recognition_end_date',
  'amount',
  'currency',
  'description',
];

export function toUtcDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    const raw = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
  }
  return date.toISOString().slice(0, 10);
}

export function collapseServicePeriod(start, end) {
  const recognitionStart = toUtcDate(start);
  const recognitionEnd = toUtcDate(end);
  if (!recognitionStart && !recognitionEnd) return { recognitionStart: '', recognitionEnd: '' };
  if (!recognitionStart) return { recognitionStart: recognitionEnd, recognitionEnd };
  if (!recognitionEnd) return { recognitionStart, recognitionEnd: recognitionStart };
  if (recognitionStart > recognitionEnd) {
    return { recognitionStart: recognitionEnd, recognitionEnd };
  }
  return { recognitionStart, recognitionEnd };
}

export function resolveServicePeriod(payment = {}, invoice = null, order = null) {
  const start = order?.createdAt || order?.created_at || invoice?.date || payment.receivedAt;
  const end = invoice?.closedAt || invoice?.paidAt || invoice?.closeoutDate || payment.receivedAt;
  return collapseServicePeriod(start, end);
}

export function stripeReferenceCandidates(payment = {}) {
  const values = [
    payment.stripeChargeId,
    payment.stripePaymentId,
    payment.stripePaymentIntentId,
    payment.reference,
    payment.id,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export function isStripeId(value) {
  const id = String(value || '').trim();
  return CHARGE_ID.test(id) || PAYMENT_ID.test(id) || PAYMENT_INTENT_ID.test(id) || CHECKOUT_SESSION_ID.test(id);
}

export function isStripeSettledPayment(payment = {}) {
  if (payment.status && payment.status !== 'completed') return false;
  if (payment.stripeChargeId && (CHARGE_ID.test(payment.stripeChargeId) || PAYMENT_ID.test(payment.stripeChargeId))) {
    return true;
  }
  return stripeReferenceCandidates(payment).some(isStripeId);
}

export function isExternalPayment(payment = {}) {
  if (payment.status && payment.status !== 'completed') return false;
  if (isStripeSettledPayment(payment)) return false;
  const method = String(payment.method || '').trim().toLowerCase();
  if (EXTERNAL_METHODS.has(method)) return true;
  // Manual card / processor without a Stripe id is treated as external.
  if (method === 'card' || method === 'processor') return true;
  return Boolean(payment.amount);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function rowsToCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map(key => csvEscape(row[key] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function paymentDescription(payment, invoice, order) {
  const parts = [
    payment.note,
    invoice?.number ? `Invoice ${invoice.number}` : '',
    order?.id ? `RO ${order.id}` : payment.workOrderId ? `RO ${payment.workOrderId}` : '',
    payment.customer,
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 500);
}

function indexByKeys(records, ...keys) {
  const map = new Map();
  for (const record of records || []) {
    for (const key of keys) {
      const value = record?.[key];
      if (value != null && value !== '') map.set(String(value), record);
    }
  }
  return map;
}

export function buildGeneralImportRows(payments, invoices = [], orders = [], {
  currency = 'usd',
  resolveChargeId = payment => payment.stripeChargeId || null,
} = {}) {
  const invoiceByNumber = indexByKeys(invoices, 'number', 'id');
  const orderById = indexByKeys(orders, 'id');
  const rows = [];

  for (const payment of payments || []) {
    if (payment?.status && payment.status !== 'completed') continue;
    const invoice = invoiceByNumber.get(String(payment.invoiceNumber || payment.targetId || '')) || null;
    const order = orderById.get(String(payment.workOrderId || (payment.targetType === 'work_order' ? payment.targetId : '') || invoice?.ro || '')) || null;
    const period = resolveServicePeriod(payment, invoice, order);
    const description = paymentDescription(payment, invoice, order);

    if (isExternalPayment(payment)) {
      const amount = Number(payment.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const booked = toUtcDate(payment.receivedAt);
      if (!booked || !period.recognitionStart || !period.recognitionEnd) continue;
      rows.push({
        source: 'ShopCrank',
        transaction_id: String(payment.id || payment.entityId || ''),
        split_transaction_id: '',
        booked_date: booked,
        recognition_start_date: period.recognitionStart,
        recognition_end_date: period.recognitionEnd,
        amount: amount.toFixed(2),
        currency: String(currency || 'usd').toLowerCase(),
        description,
      });
      continue;
    }

    if (isStripeSettledPayment(payment)) {
      const chargeId = resolveChargeId(payment);
      const id = String(chargeId || '').trim();
      if (!CHARGE_ID.test(id) && !PAYMENT_ID.test(id)) continue;
      if (!period.recognitionStart || !period.recognitionEnd) continue;
      rows.push({
        source: 'Stripe',
        transaction_id: id,
        split_transaction_id: '',
        booked_date: '',
        recognition_start_date: period.recognitionStart,
        recognition_end_date: period.recognitionEnd,
        amount: '',
        currency: '',
        description,
      });
    }
  }

  return rows.filter(row => row.transaction_id);
}

export function buildGeneralImportCsv(payments, invoices, orders, options) {
  return rowsToCsv(buildGeneralImportRows(payments, invoices, orders, options));
}

async function stripeGet(stripeKey, path, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `Stripe request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function resolveStripeChargeId(stripeKey, payment, { fetchImpl = fetch } = {}) {
  if (!stripeKey || !payment) return null;
  const existing = String(payment.stripeChargeId || '').trim();
  if (CHARGE_ID.test(existing) || PAYMENT_ID.test(existing)) return existing;

  for (const candidate of stripeReferenceCandidates(payment)) {
    if (CHARGE_ID.test(candidate) || PAYMENT_ID.test(candidate)) return candidate;
    if (PAYMENT_INTENT_ID.test(candidate)) {
      const intent = await stripeGet(stripeKey, `payment_intents/${candidate}`, fetchImpl);
      const charge = String(intent.latest_charge || '').trim();
      if (CHARGE_ID.test(charge) || PAYMENT_ID.test(charge)) return charge;
    }
    if (CHECKOUT_SESSION_ID.test(candidate)) {
      const session = await stripeGet(stripeKey, `checkout/sessions/${candidate}`, fetchImpl);
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
      if (PAYMENT_INTENT_ID.test(String(paymentIntentId || ''))) {
        const intent = await stripeGet(stripeKey, `payment_intents/${paymentIntentId}`, fetchImpl);
        const charge = String(intent.latest_charge || '').trim();
        if (CHARGE_ID.test(charge) || PAYMENT_ID.test(charge)) return charge;
      }
    }
  }
  return null;
}

export async function enrichStripePaymentIds(stripeKey, sessionOrIntent, { fetchImpl = fetch } = {}) {
  const result = {
    stripePaymentIntentId: '',
    stripeChargeId: '',
  };
  if (!stripeKey || !sessionOrIntent) return result;

  if (sessionOrIntent.object === 'checkout.session') {
    const paymentIntentId = typeof sessionOrIntent.payment_intent === 'string'
      ? sessionOrIntent.payment_intent
      : sessionOrIntent.payment_intent?.id;
    result.stripePaymentIntentId = String(paymentIntentId || '').trim();
  } else if (sessionOrIntent.object === 'payment_intent') {
    result.stripePaymentIntentId = String(sessionOrIntent.id || '').trim();
    result.stripeChargeId = String(sessionOrIntent.latest_charge || '').trim();
  }

  if (result.stripePaymentIntentId && !result.stripeChargeId) {
    try {
      const intent = await stripeGet(stripeKey, `payment_intents/${result.stripePaymentIntentId}`, fetchImpl);
      result.stripeChargeId = String(intent.latest_charge || '').trim();
    } catch {
      // Leave blank; export-time resolution can retry.
    }
  }
  return result;
}

export function revrecObjectKey(shopId, date = new Date()) {
  const day = toUtcDate(date) || new Date().toISOString().slice(0, 10);
  return `revrec/${shopId}/general/${day}.csv`;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha256(key, message) {
  const rawKey = typeof key === 'string'
    ? new TextEncoder().encode(key)
    : key instanceof Uint8Array
      ? key
      : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(payload) {
  const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * AWS SigV4 PUT for S3 object. Keeps the Worker free of the AWS SDK.
 */
export async function uploadDailyCsv(env, shopId, csv, {
  date = new Date(),
  fetchImpl = fetch,
} = {}) {
  const bucket = String(env.REVREC_S3_BUCKET || '').trim();
  const region = String(env.REVREC_S3_REGION || 'us-east-1').trim();
  const accessKeyId = String(env.REVREC_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.REVREC_S3_SECRET_ACCESS_KEY || '').trim();
  if (!bucket || !accessKeyId || !secretAccessKey) {
    const error = new Error('Revenue Recognition S3 is not configured on the platform');
    error.status = 503;
    throw error;
  }

  const objectKey = revrecObjectKey(shopId, date);
  const host = region === 'us-east-1' ? `${bucket}.s3.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`;
  const url = `https://${host}/${objectKey.split('/').map(encodeRfc3986).join('/')}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(csv);
  const contentType = 'text/csv; charset=utf-8';
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n');
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    `/${objectKey.split('/').map(encodeRfc3986).join('/')}`,
    '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: csv,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`S3 upload failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    error.status = 502;
    throw error;
  }
  return { objectKey, bucket, region };
}

export async function getRevrecConfig(env, shopId) {
  const row = await env.DB.prepare(`
    SELECT shop_id, enabled, currency, last_exported_at, last_object_key, last_error, updated_at
    FROM revenue_recognition_exports
    WHERE shop_id = ?
  `).bind(shopId).first();
  return row || {
    shop_id: shopId,
    enabled: 0,
    currency: 'usd',
    last_exported_at: null,
    last_object_key: null,
    last_error: null,
    updated_at: null,
  };
}

export async function upsertRevrecConfig(env, shopId, { enabled, currency } = {}) {
  const existing = await getRevrecConfig(env, shopId);
  const nextEnabled = enabled == null ? Number(existing.enabled || 0) : (enabled ? 1 : 0);
  const nextCurrency = String(currency || existing.currency || 'usd').trim().toLowerCase() || 'usd';
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO revenue_recognition_exports (
      shop_id, enabled, currency, last_exported_at, last_object_key, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      enabled = excluded.enabled,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `).bind(
    shopId,
    nextEnabled,
    nextCurrency,
    existing.last_exported_at,
    existing.last_object_key,
    existing.last_error,
    now,
  ).run();
  return getRevrecConfig(env, shopId);
}

export async function markRevrecExport(env, shopId, { objectKey = null, error = null } = {}) {
  const existing = await getRevrecConfig(env, shopId);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO revenue_recognition_exports (
      shop_id, enabled, currency, last_exported_at, last_object_key, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      last_exported_at = excluded.last_exported_at,
      last_object_key = excluded.last_object_key,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).bind(
    shopId,
    Number(existing.enabled || 0),
    existing.currency || 'usd',
    error ? existing.last_exported_at : now,
    error ? existing.last_object_key : objectKey,
    error ? String(error).slice(0, 1000) : null,
    now,
  ).run();
  return getRevrecConfig(env, shopId);
}

export async function listEnabledRevrecShops(env) {
  const result = await env.DB.prepare(`
    SELECT shop_id, enabled, currency, last_exported_at, last_object_key, last_error, updated_at
    FROM revenue_recognition_exports
    WHERE enabled = 1
  `).all();
  return result.results || [];
}

export function s3Configured(env) {
  return Boolean(
    String(env?.REVREC_S3_BUCKET || '').trim()
    && String(env?.REVREC_S3_ACCESS_KEY_ID || '').trim()
    && String(env?.REVREC_S3_SECRET_ACCESS_KEY || '').trim(),
  );
}

export function revrecStatusPayload(config, { stripeConfigured = false, s3Ready = false, shopId = '' } = {}) {
  const enabled = Boolean(Number(config?.enabled || 0));
  return {
    enabled,
    currency: config?.currency || 'usd',
    lastExportedAt: config?.last_exported_at || null,
    lastObjectKey: config?.last_object_key || null,
    lastError: config?.last_error || null,
    stripeConfigured,
    s3Configured: s3Ready,
    shopId,
    folderHint: shopId ? `revrec/${shopId}/general/` : null,
  };
}
