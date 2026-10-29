import { resolveTwilioShopConfig, sendSms } from './integrations/sms.mjs';

/**
 * Automatic customer follow-ups, included on every plan:
 *  - Service reminders: completed work creates a reminder for the next service
 *    (oil every 6 months, rotation 6, brake check 12, ...), and due reminders
 *    are texted automatically.
 *  - Google review requests: a paid invoice triggers one review-link text,
 *    at most once per customer per `minDaysBetween`.
 * Settings live in shopsettings/followups; sending needs the shop's Twilio
 * number (or ShopCrank's platform number). Opted-out phones are never texted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Daily 15:00 UTC (9-10 AM US Central); must match triggers.crons in wrangler.jsonc.
export const FOLLOWUP_CRON = '0 15 * * *';

export const DEFAULT_SERVICE_INTERVALS = Object.freeze([
  { id: 'oil', service: 'Oil change', match: 'oil change|oil service|lube|oil & filter|oil and filter', months: 6 },
  { id: 'rotation', service: 'Tire rotation', match: 'rotat', months: 6 },
  { id: 'brakes', service: 'Brake inspection', match: 'brake', months: 12 },
  { id: 'cabin', service: 'Cabin air filter', match: 'cabin (air )?filter', months: 12 },
  { id: 'coolant', service: 'Coolant service', match: 'coolant|antifreeze|radiator flush', months: 24 },
  { id: 'trans', service: 'Transmission service', match: 'transmission (fluid|service|flush)|atf', months: 30 },
]);

export const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
  reviewRequests: { enabled: true, googleReviewUrl: '', delayHours: 2, minDaysBetween: 180, maxAgeDays: 7 },
  serviceReminders: { enabled: true, autoCreate: true, autoSend: true, leadDays: 7, intervals: DEFAULT_SERVICE_INTERVALS },
});

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

export function followupSettings(record = {}) {
  const review = { ...DEFAULT_FOLLOWUP_SETTINGS.reviewRequests, ...(record.reviewRequests || {}) };
  const reminders = { ...DEFAULT_FOLLOWUP_SETTINGS.serviceReminders, ...(record.serviceReminders || {}) };
  if (!Array.isArray(reminders.intervals) || !reminders.intervals.length) reminders.intervals = DEFAULT_SERVICE_INTERVALS;
  return { reviewRequests: review, serviceReminders: reminders };
}

/** Accept Google review links and bare Place IDs; anything else is rejected. */
export function normalizeGoogleReviewUrl(value) {
  const text = clean(value, 500);
  if (!text) return '';
  if (/^ChIJ[\w-]{10,}$/.test(text)) return `https://search.google.com/local/writereview?placeid=${text}`;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === 'https:' && (host === 'g.page' || host === 'search.google.com' || host === 'maps.app.goo.gl' || host === 'goo.gl' || host.endsWith('.google.com') || host === 'google.com');
    return allowed ? url.toString() : '';
  } catch {
    return '';
  }
}

function addMonths(isoDate, months) {
  const date = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  return date.toISOString().slice(0, 10);
}

function orderServiceText(order) {
  const lines = (order.estimate?.lines || []).filter(line => line.approvalStatus !== 'declined').map(line => `${line.description || ''} ${line.service || ''}`);
  return [order.complaint, order.service, ...lines].join(' \n ').toLowerCase();
}

function completedAt(order) {
  return String(order.completedAt || order.closedAt || order.invoicedAt || (['completed', 'invoiced', 'paid', 'closed'].includes(order.status) ? order.updatedAt : '') || '').slice(0, 10);
}

/**
 * Next-service reminders implied by completed work orders that the shop doesn't
 * already track. One reminder per vehicle per interval, from the latest service.
 */
export function plannedServiceReminders(orders = [], existingReminders = [], settings = followupSettings()) {
  const latest = new Map();
  for (const order of orders) {
    const done = completedAt(order);
    if (!done || !order.vehicle) continue;
    const text = orderServiceText(order);
    for (const interval of settings.serviceReminders.intervals) {
      if (!new RegExp(interval.match, 'i').test(text)) continue;
      const key = `${String(order.vin || order.vehicle).toUpperCase()}|${interval.id}`;
      if (!latest.has(key) || latest.get(key).done < done) latest.set(key, { order, interval, done });
    }
  }
  const tracked = new Set(existingReminders.map(item => item.sourceKey).filter(Boolean));
  const planned = [];
  for (const [key, { order, interval, done }] of latest) {
    const sourceKey = `${key}|${done}`;
    if (tracked.has(sourceKey)) continue;
    planned.push({
      id: `reminder-auto-${sourceKey.replace(/[^A-Za-z0-9|-]/g, '').replace(/\|/g, '-')}`.slice(0, 120),
      customer: order.customer || '',
      customerId: order.customerId || '',
      phone: order.phone || '',
      vehicle: order.vehicle,
      vin: order.vin || '',
      service: interval.service,
      dueDate: addMonths(done, interval.months),
      channel: 'sms',
      source: 'auto',
      sourceKey,
      lastServiceDate: done,
      orderId: order.id || '',
    });
  }
  return planned;
}

export function dueReminders(reminders = [], { today, leadDays = 7 } = {}) {
  const horizon = new Date(Date.parse(`${today}T12:00:00Z`) + leadDays * DAY_MS).toISOString().slice(0, 10);
  return reminders.filter(item => !item.sentAt && item.status !== 'cancelled' && item.dueDate && item.dueDate <= horizon);
}

export function reminderMessage(reminder, shopName, bookingUrl = '') {
  const vehicle = reminder.vehicle ? ` for your ${reminder.vehicle}` : '';
  return `${shopName}: ${reminder.service} is due${vehicle}${reminder.dueDate ? ` around ${reminder.dueDate}` : ''}.${bookingUrl ? ` Book online: ${bookingUrl}` : ' Reply to this text to schedule.'} Reply STOP to opt out.`;
}

export function reviewRequestMessage(customerName, shopName, url) {
  const first = String(customerName || '').split(' ')[0];
  return `Thanks for choosing ${shopName}${first ? `, ${first}` : ''}! If we earned it, would you leave us a quick Google review? ${url} Reply STOP to opt out.`;
}

/** Paid invoices whose customers should get a review request now. */
export function dueReviewRequests(invoices = [], { now = Date.now(), settings = followupSettings(), lastRequestByPhone = new Map(), optedOut = new Set(), customers = [] } = {}) {
  const review = settings.reviewRequests;
  if (!review.enabled || !normalizeGoogleReviewUrl(review.googleReviewUrl)) return [];
  const due = [];
  const seen = new Set();
  for (const invoice of invoices) {
    if (invoice.reviewRequestedAt || String(invoice.status || '').toLowerCase() !== 'paid') continue;
    const paid = Date.parse(invoice.paidAt || invoice.closedAt || '');
    if (!Number.isFinite(paid) || now - paid < review.delayHours * 3600_000 || now - paid > review.maxAgeDays * DAY_MS) continue;
    const customer = customers.find(item => item.id === invoice.customerId || item.name === invoice.customer);
    const phone = clean(invoice.phone || customer?.phone, 40);
    const key = phone.replace(/\D/g, '').slice(-10);
    if (key.length < 10 || optedOut.has(key) || seen.has(key)) continue;
    const last = Date.parse(lastRequestByPhone.get(key) || '');
    if (Number.isFinite(last) && now - last < review.minDaysBetween * DAY_MS) continue;
    seen.add(key);
    due.push({ invoice, phone, customer: invoice.customer || customer?.name || '', customerId: customer?.id || invoice.customerId || '' });
  }
  return due;
}

export function toE164(value) {
  const raw = clean(value, 40);
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

function parse(row) {
  try { return JSON.parse(row?.data_json || 'null'); } catch { return null; }
}

async function list(env, shopId, type) {
  const result = await env.DB.prepare('SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = ?').bind(shopId, type).all();
  return (result.results || []).map(row => ({ ...(parse(row) || {}), id: parse(row)?.id || row.entity_id }));
}

async function put(env, shopId, type, record) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'followups', ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `).bind(shopId, type, record.id, JSON.stringify({ ...record, createdAt: record.createdAt || now, updatedAt: now }), record.createdAt || now, now).run();
}

async function recordMessage(env, shopId, { phone, body, messageType, customerId, result }) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO customer_messages (id, shop_id, customer_id, work_order_id, phone, direction, body, provider, provider_message_id, message_type, status, created_at)
    VALUES (?, ?, ?, NULL, ?, 'outbound', ?, ?, ?, ?, ?, ?)
  `).bind(`sms-${crypto.randomUUID()}`, shopId, customerId || null, phone, body, result.provider || 'twilio', result.messageSid || null, messageType, result.status || 'sent', new Date().toISOString()).run();
}

/** Run follow-ups for one shop. `send` is injectable for tests; defaults to Twilio. */
export async function runShopFollowups(env, shopId, { now = Date.now(), getSecret = null, send = null, bookingOrigin = '' } = {}) {
  const [settingsRows, orders, invoices, reminders, customers, shop] = await Promise.all([
    env.DB.prepare("SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = 'shopsettings' AND entity_id IN ('followups', 'profile')").bind(shopId).all(),
    list(env, shopId, 'orders'),
    list(env, shopId, 'invoices'),
    list(env, shopId, 'reminders'),
    list(env, shopId, 'customers'),
    env.DB.prepare('SELECT name FROM shops WHERE id = ?').bind(shopId).first(),
  ]);
  const byId = Object.fromEntries((settingsRows.results || []).map(row => [row.entity_id, parse(row) || {}]));
  const settings = followupSettings(byId.followups);
  const shopName = clean(byId.profile?.shopName || shop?.name || 'Your shop', 120);
  const report = { shopId, remindersCreated: 0, remindersSent: 0, reviewRequestsSent: 0, skipped: 0, errors: [] };

  let deliver = send;
  if (!deliver) {
    const twilio = await resolveTwilioShopConfig(env, shopId, getSecret);
    if (twilio.configured) deliver = message => sendSms(env, message, { config: twilio });
  }
  const consent = await env.DB.prepare("SELECT phone FROM sms_consent WHERE shop_id = ? AND status = 'opted_out'").bind(shopId).all().catch(() => ({ results: [] }));
  const optedOut = new Set((consent.results || []).map(row => String(row.phone || '').replace(/\D/g, '').slice(-10)));
  const textCustomer = async ({ phone, body, messageType, customerId }) => {
    const to = toE164(phone);
    if (!deliver || !to || optedOut.has(to.replace(/\D/g, '').slice(-10))) { report.skipped += 1; return false; }
    try {
      const result = await deliver({ to, body });
      await recordMessage(env, shopId, { phone: to, body, messageType, customerId, result: result || {} });
      return true;
    } catch (error) {
      report.errors.push(error.message || String(error));
      return false;
    }
  };

  const today = new Date(now).toISOString().slice(0, 10);
  if (settings.serviceReminders.enabled) {
    const all = [...reminders];
    if (settings.serviceReminders.autoCreate) {
      for (const reminder of plannedServiceReminders(orders, reminders, settings)) {
        const customer = customers.find(item => item.id === reminder.customerId || item.name === reminder.customer);
        const record = { ...reminder, phone: reminder.phone || customer?.phone || '', customerId: reminder.customerId || customer?.id || '' };
        await put(env, shopId, 'reminders', record);
        all.push(record);
        report.remindersCreated += 1;
      }
    }
    if (settings.serviceReminders.autoSend) {
      const bookingUrl = bookingOrigin ? `${bookingOrigin}/api/book/${encodeURIComponent(shopId)}` : '';
      for (const reminder of dueReminders(all, { today, leadDays: settings.serviceReminders.leadDays })) {
        const customer = customers.find(item => item.id === reminder.customerId || item.name === reminder.customer);
        const sent = await textCustomer({ phone: reminder.phone || customer?.phone, body: reminderMessage(reminder, shopName, bookingUrl), messageType: 'reminder', customerId: customer?.id });
        if (sent) {
          await put(env, shopId, 'reminders', { ...reminder, sentAt: new Date(now).toISOString(), sentBy: 'auto' });
          report.remindersSent += 1;
        }
      }
    }
  }

  if (settings.reviewRequests.enabled) {
    const url = normalizeGoogleReviewUrl(settings.reviewRequests.googleReviewUrl);
    const history = await env.DB.prepare("SELECT phone, MAX(created_at) AS last FROM customer_messages WHERE shop_id = ? AND message_type = 'review_request' GROUP BY phone").bind(shopId).all().catch(() => ({ results: [] }));
    const lastRequestByPhone = new Map((history.results || []).map(row => [String(row.phone || '').replace(/\D/g, '').slice(-10), row.last]));
    for (const due of dueReviewRequests(invoices, { now, settings, lastRequestByPhone, optedOut, customers })) {
      const sent = await textCustomer({ phone: due.phone, body: reviewRequestMessage(due.customer, shopName, url), messageType: 'review_request', customerId: due.customerId });
      if (sent) {
        await put(env, shopId, 'invoices', { ...due.invoice, reviewRequestedAt: new Date(now).toISOString() });
        report.reviewRequestsSent += 1;
      }
    }
  }
  return report;
}

/** Daily cron: every shop with an active or trialing subscription. */
export async function runScheduledFollowups(env, options = {}) {
  const shops = await env.DB.prepare("SELECT shop_id FROM subscriptions WHERE status IN ('active', 'trialing')").all();
  const reports = [];
  for (const row of shops.results || []) {
    try {
      reports.push(await runShopFollowups(env, row.shop_id, options));
    } catch (error) {
      reports.push({ shopId: row.shop_id, errors: [error.message || String(error)] });
    }
  }
  return reports;
}
