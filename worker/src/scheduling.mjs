/**
 * Shop calendar availability and booking, shared by the AI phone receptionist
 * and the public online-booking page. Appointments use the same record shape as
 * the Schedule screen: { id, customer, customerId, phone, vehicle, date
 * (YYYY-MM-DD), time (HH:MM), service, status, source }.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
export const DEFAULT_BOOKING = Object.freeze({ slotMinutes: 60, capacity: 2, leadMinutes: 60, horizonDays: 21 });
const OPEN_STATUSES = new Set(['scheduled', 'confirmed', 'checked_in', 'in_progress', '']);

function dayIndex(word) {
  const key = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  const full = DAY_NAMES.indexOf(key);
  return full >= 0 ? full : DAY_ALIASES[key] ?? DAY_ALIASES[key.slice(0, 3)] ?? -1;
}

function minutesFrom(text) {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(String(text || ''));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = String(match[3] || '').toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return hour > 23 || minute > 59 ? null : hour * 60 + minute;
}

/**
 * Parse hours such as "Monday–Friday 8:00 AM – 5:30 PM; Saturday 9 AM - 1 PM".
 * Returns { [dayIndex]: { open, close } } in minutes after midnight.
 */
export function parseShopHours(text) {
  const schedule = {};
  for (const part of String(text || '').split(/[;\n]|,(?=\s*[A-Za-z]{3,}\s*[–—-])/)) {
    const days = /([A-Za-z]{3,})(?:\s*(?:[–—-]|to|through)\s*([A-Za-z]{3,}))?/.exec(part);
    const times = part.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/gi) || [];
    if (!days || times.length < 2) continue;
    const start = dayIndex(days[1]);
    const end = days[2] ? dayIndex(days[2]) : start;
    const open = minutesFrom(times[0]);
    const close = minutesFrom(times[1]);
    if (start < 0 || end < 0 || open === null || close === null || close <= open) continue;
    for (let day = start; ; day = (day + 1) % 7) {
      schedule[day] = { open, close };
      if (day === end) break;
    }
  }
  if (!Object.keys(schedule).length) for (let day = 1; day <= 5; day += 1) schedule[day] = { open: 8 * 60, close: 17 * 60 + 30 };
  return schedule;
}

const pad = value => String(value).padStart(2, '0');
export const timeLabel = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** YYYY-MM-DD and minutes-after-midnight for an instant in the shop's time zone. */
export function shopClock(at = new Date(), timeZone = 'America/Chicago') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function validBookingDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

/** Open start times on one date given the hours, existing appointments, and bay capacity. */
export function availableSlots({ date, hours, appointments = [], config = {}, now = shopClock() }) {
  const { slotMinutes, capacity, leadMinutes } = { ...DEFAULT_BOOKING, ...config };
  if (!validBookingDate(date) || date < now.date) return [];
  const day = hours[weekday(date)];
  if (!day) return [];
  const taken = new Map();
  for (const appointment of appointments) {
    if (appointment?.date !== date || !OPEN_STATUSES.has(String(appointment.status || '').toLowerCase())) continue;
    taken.set(appointment.time, (taken.get(appointment.time) || 0) + 1);
  }
  const slots = [];
  for (let start = day.open; start + slotMinutes <= day.close; start += slotMinutes) {
    if (date === now.date && start < now.minutes + leadMinutes) continue;
    if ((taken.get(timeLabel(start)) || 0) < capacity) slots.push(timeLabel(start));
  }
  return slots;
}

/** The next few dates with openings, starting at `from` (shop-local YYYY-MM-DD). */
export function nextAvailability({ from, hours, appointments, config = {}, now = shopClock(), days = 3 }) {
  const { horizonDays } = { ...DEFAULT_BOOKING, ...config };
  const result = [];
  let date = validBookingDate(from) && from > now.date ? from : now.date;
  for (let step = 0; step < horizonDays && result.length < days; step += 1, date = addDays(date, 1)) {
    const slots = availableSlots({ date, hours, appointments, config, now });
    if (slots.length) result.push({ date, slots });
  }
  return result;
}

function parseRow(row) {
  try { return JSON.parse(row?.data_json || 'null'); } catch { return null; }
}

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

export async function loadBookingContext(env, shopId) {
  const [shop, settings, appointments] = await Promise.all([
    env.DB.prepare('SELECT name, timezone FROM shops WHERE id = ?').bind(shopId).first(),
    env.DB.prepare("SELECT entity_id, data_json FROM entities WHERE shop_id = ? AND entity_type = 'shopsettings' AND entity_id IN ('profile', 'grok_phone', 'booking')").bind(shopId).all(),
    env.DB.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'appointments' AND json_extract(data_json, '$.date') >= ?").bind(shopId, shopClock(new Date(), 'UTC').date.slice(0, 8) + '01').all(),
  ]);
  const byId = Object.fromEntries((settings.results || []).map(row => [row.entity_id, parseRow(row) || {}]));
  const profile = byId.profile || {};
  const booking = byId.booking || {};
  const timeZone = cleanText(shop?.timezone || 'America/Chicago', 64) || 'America/Chicago';
  return {
    shopName: cleanText(profile.shopName || shop?.name || '', 160),
    timeZone,
    hoursText: cleanText(booking.hours || byId.grok_phone?.shopHours || profile.hours || '', 300),
    hours: parseShopHours(booking.hours || byId.grok_phone?.shopHours || profile.hours),
    config: {
      slotMinutes: Number(booking.slotMinutes) > 0 ? Math.min(240, Number(booking.slotMinutes)) : DEFAULT_BOOKING.slotMinutes,
      capacity: Number(booking.capacity) > 0 ? Math.min(20, Number(booking.capacity)) : DEFAULT_BOOKING.capacity,
      leadMinutes: Number(booking.leadMinutes) >= 0 && booking.leadMinutes !== undefined ? Math.min(7 * 24 * 60, Number(booking.leadMinutes)) : DEFAULT_BOOKING.leadMinutes,
      horizonDays: DEFAULT_BOOKING.horizonDays,
    },
    onlineBookingEnabled: booking.enabled !== false,
    services: Array.isArray(booking.services) ? booking.services.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 30) : [],
    appointments: (appointments.results || []).map(parseRow).filter(Boolean),
    now: shopClock(new Date(), timeZone),
  };
}

async function upsertEntity(env, shopId, type, id, record, createdBy) {
  const now = new Date().toISOString();
  const value = { ...record, id, shopId, createdBy, createdAt: record.createdAt || now, updatedAt: now };
  await env.DB.prepare(`
    INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `).bind(shopId, type, id, JSON.stringify(value), createdBy, value.createdAt, now).run();
  return value;
}

export async function findCustomerByPhone(env, shopId, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 7) return null;
  const row = await env.DB.prepare(`
    SELECT entity_id, data_json FROM entities
    WHERE shop_id = ? AND entity_type = 'customers'
      AND replace(replace(replace(replace(replace(json_extract(data_json, '$.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
    LIMIT 1
  `).bind(shopId, `%${digits}`).first();
  const customer = parseRow(row);
  return customer ? { ...customer, id: customer.id || row.entity_id } : null;
}

export class BookingError extends Error {
  constructor(message, status = 409, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Book a real appointment on the shop calendar. Re-checks the slot against the
 * calendar at write time and links or creates the customer by phone number.
 */
export async function bookAppointment(env, shopId, input = {}, { source = 'ai_phone', createdBy = 'ai-phone' } = {}) {
  const context = await loadBookingContext(env, shopId);
  const date = cleanText(input.date, 10);
  const time = cleanText(input.time, 5);
  const name = cleanText(input.customerName || input.customer || input.name, 120);
  const phone = cleanText(input.phone, 40);
  const vehicle = cleanText(input.vehicle, 160);
  const service = cleanText(input.service || input.reason, 200);
  if (!name || !phone) throw new BookingError('Customer name and phone number are required to book', 400);
  if (!vehicle || !service) throw new BookingError('Vehicle and service are required to book', 400);
  if (!validBookingDate(date) || !/^\d{2}:\d{2}$/.test(time)) throw new BookingError('Choose a date (YYYY-MM-DD) and time (HH:MM)', 400);
  const open = availableSlots({ date, hours: context.hours, appointments: context.appointments, config: context.config, now: context.now });
  if (!open.includes(time)) {
    throw new BookingError('That time is not available', 409, {
      alternatives: nextAvailability({ from: date, hours: context.hours, appointments: context.appointments, config: context.config, now: context.now }),
    });
  }
  const existing = await findCustomerByPhone(env, shopId, phone);
  let customer = existing;
  if (!customer) {
    // Customers are keyed by name; never overwrite a different customer who shares it.
    const taken = await env.DB.prepare("SELECT 1 FROM entities WHERE shop_id = ? AND entity_type = 'customers' AND entity_id = ?").bind(shopId, name).first();
    const customerId = taken ? `${name} (${phone.replace(/\D/g, '').slice(-4)})` : name;
    customer = await upsertEntity(env, shopId, 'customers', customerId, {
      name: customerId, phone, email: cleanText(input.email, 254), source, notes: `Created from ${source === 'online_booking' ? 'online booking' : 'AI phone call'}`,
    }, createdBy);
  }
  const id = `appointment-${crypto.randomUUID()}`;
  const appointment = await upsertEntity(env, shopId, 'appointments', id, {
    customer: customer.name || name,
    customerId: customer.id || name,
    phone,
    email: cleanText(input.email, 254),
    vehicle,
    date,
    time,
    service,
    notes: cleanText(input.notes, 1000),
    status: 'scheduled',
    source,
    tech: '',
    bay: '',
  }, createdBy);
  return { appointment, customer, returningCustomer: Boolean(existing) };
}
