import test from 'node:test';
import assert from 'node:assert/strict';
import { availableSlots, bookAppointment, nextAvailability, parseShopHours, shopClock } from '../src/scheduling.mjs';
import { GROK_SHOP_TOOLS, buildGrokInstructions, executeGrokShopTool } from '../src/grok-voice.mjs';
import { agentPhoneCallSummary, buildCallSummary, callActionFromTool, extractiveCallSummary } from '../src/call-summaries.mjs';
import { callLogHtml } from '../../src/modules/call-log.js';
import { createD1 } from './helpers/d1-sqlite.mjs';

const hours = parseShopHours('Monday–Friday 8:00 AM – 5:30 PM; Saturday 9 AM - 1 PM');

test('shop hours parse into a weekly schedule; unknown text falls back to weekdays 8–5:30', () => {
  assert.deepEqual(hours[1], { open: 480, close: 1050 });
  assert.deepEqual(hours[5], { open: 480, close: 1050 });
  assert.deepEqual(hours[6], { open: 540, close: 780 });
  assert.equal(hours[0], undefined);
  assert.deepEqual(Object.keys(parseShopHours('call us')).map(Number), [1, 2, 3, 4, 5]);
});

test('slots respect hours, capacity, lead time, and cancelled appointments', () => {
  const now = { date: '2026-11-02', minutes: 9 * 60 + 30 };
  const appointments = [
    { date: '2026-11-02', time: '11:00', status: 'scheduled' },
    { date: '2026-11-02', time: '11:00', status: 'confirmed' },
    { date: '2026-11-02', time: '12:00', status: 'cancelled' },
  ];
  const slots = availableSlots({ date: '2026-11-02', hours, appointments, config: { capacity: 2 }, now });
  assert.equal(slots[0], '12:00', 'first open slot after the lead time and the full 11:00 slot');
  assert.ok(!slots.includes('08:00') && !slots.includes('10:00'), 'nothing within the one-hour lead time');
  assert.ok(!slots.includes('11:00'), 'full slot hidden');
  assert.ok(slots.includes('12:00'), 'cancelled appointment frees the slot');
  assert.equal(slots.at(-1), '16:00', 'last slot ends before close');
  assert.deepEqual(availableSlots({ date: '2026-11-01', hours, now }), [], 'closed Sunday');
  assert.deepEqual(availableSlots({ date: '2026-10-30', hours, now }), [], 'past date');
  const next = nextAvailability({ from: '2026-11-01', hours, appointments, now, days: 2 });
  assert.deepEqual(next.map(day => day.date), ['2026-11-02', '2026-11-03']);
  assert.match(shopClock(new Date('2026-11-02T15:00:00Z'), 'America/Chicago').date, /^2026-11-02$/);
});

async function shop() {
  const DB = createD1();
  const now = new Date().toISOString();
  DB.sqlite.exec(`INSERT INTO shops (id, name, slug, timezone, created_at, updated_at) VALUES ('shop-a', 'Lubbock Brake & Tire', 'shop-a', 'America/Chicago', '${now}', '${now}')`);
  const put = (type, id, data) => DB.prepare('INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('shop-a', type, id, JSON.stringify({ id, ...data }), 'u', now, now).runSync();
  put('shopsettings', 'booking', { hours: 'Monday-Sunday 7:00 AM - 7:00 PM', capacity: 1, leadMinutes: 0 });
  put('customers', 'Alice Brooks', { name: 'Alice Brooks', phone: '(806) 555-0101' });
  const read = type => DB.sqlite.prepare('SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = ?').all('shop-a', type).map(row => JSON.parse(row.data_json));
  return { env: { DB }, read };
}

function tomorrow() {
  const date = new Date(Date.now() + 2 * 86400000);
  return date.toISOString().slice(0, 10);
}

test('the AI phone books a real appointment, links the returning caller, and refuses a taken slot', async () => {
  const { env, read } = await shop();
  assert.ok(GROK_SHOP_TOOLS.some(tool => tool.name === 'book_appointment'));
  assert.ok(GROK_SHOP_TOOLS.some(tool => tool.name === 'check_appointment_availability'));
  const date = tomorrow();
  const availability = await executeGrokShopTool(env, 'shop-a', 'check_appointment_availability', { date });
  assert.equal(availability.days[0].date, date);
  const time = availability.days[0].times[0];
  const booked = await executeGrokShopTool(env, 'shop-a', 'book_appointment', { customerName: 'Alice', vehicle: '2019 Camry', service: 'Brake noise', date, time }, { callerPhone: '+18065550101' });
  assert.equal(booked.booked, true, JSON.stringify(booked));
  assert.equal(booked.returningCustomer, true);
  const [appointment] = read('appointments');
  assert.equal(appointment.customer, 'Alice Brooks', 'matched by Caller ID, not the spoken name');
  assert.equal(appointment.customerId, 'Alice Brooks');
  assert.equal(appointment.source, 'ai_phone');
  assert.equal(appointment.status, 'scheduled');
  const again = await executeGrokShopTool(env, 'shop-a', 'book_appointment', { customerName: 'Ben', vehicle: 'F-150', service: 'Oil', date, time }, { callerPhone: '+18065550199' });
  assert.equal(again.booked, false);
  assert.match(again.error, /not available/);
  assert.ok(again.alternatives.length > 0);
});

test('a new caller gets a customer record; a same-name customer is never overwritten', async () => {
  const { env, read } = await shop();
  const date = tomorrow();
  const result = await bookAppointment(env, 'shop-a', { customerName: 'Alice Brooks', phone: '806-555-0177', vehicle: 'Civic', service: 'Inspection', date, time: '09:00' }, { source: 'online_booking' });
  assert.equal(result.returningCustomer, false);
  const customers = read('customers');
  assert.equal(customers.length, 2);
  assert.equal(customers.find(c => c.phone === '(806) 555-0101').name, 'Alice Brooks');
  assert.equal(result.customer.name, 'Alice Brooks (0177)');
});

test('instructions greet returning callers by name and tell the agent today\'s date', () => {
  const text = buildGrokInstructions({ shopSettings: { shopName: 'Lubbock Brake & Tire' }, callerContext: { customer: { name: 'Alice Brooks' } }, today: '2026-11-02' });
  assert.match(text, /Returning customer/);
  assert.match(text, /Greet them by first name/);
  assert.match(text, /Today is 2026-11-02/);
  assert.match(text, /book_appointment/);
});

test('call summaries say who called, why, and what was booked', async () => {
  const actions = [
    callActionFromTool('lookup_customer_and_vehicles', { query: 'Alice' }, { count: 1 }),
    callActionFromTool('book_appointment', {}, { booked: true, appointmentId: 'appointment-1', date: '2026-11-03', time: '09:00', service: 'Brake noise' }),
  ];
  const transcript = [
    { role: 'grok', text: 'Thanks for calling!' },
    { role: 'caller', text: 'Hi, my brakes are grinding on the Camry' },
    { role: 'caller', text: 'Tuesday works' },
  ];
  const text = extractiveCallSummary({ transcript, actions, callerName: 'Alice Brooks' });
  assert.equal(text, 'Alice Brooks called about: "Hi, my brakes are grinding on the Camry". Looked up the customer\'s records. Booked Brake noise for 2026-11-03 at 09:00.');
  const record = await buildCallSummary({}, { shopId: 'shop-a', callSid: 'CA1', caller: '+18065550101', callerContext: { customer: { id: 'Alice Brooks', name: 'Alice Brooks' } }, transcript, actions, durationSeconds: 95 });
  assert.equal(record.outcome, 'booked');
  assert.equal(record.appointmentId, 'appointment-1');
  assert.equal(record.returningCaller, true);
  assert.equal(record.summarySource, 'transcript');
  const ai = await buildCallSummary({ AI: { run: async () => ({ response: 'Alice booked brake work for Tuesday 9 AM.' }) } }, { shopId: 'shop-a', transcript, actions });
  assert.equal(ai.summary, 'Alice booked brake work for Tuesday 9 AM.');
  assert.equal(ai.summarySource, 'ai');
  const html = callLogHtml([record]);
  assert.match(html, /Returning/);
  assert.match(html, /Booked/);
  assert.match(html, /data-edit-appointment="appointment-1"/);
});

test('AgentPhone call_ended payloads become call summaries matched to the customer', async () => {
  const { env } = await shop();
  const record = await agentPhoneCallSummary(env, 'shop-a', { event: 'agent.call_ended', data: { callId: 'ap-1', from: '+18065550101', transcript: [{ role: 'user', text: 'Is my truck ready yet?' }, { role: 'assistant', text: 'Let me check.' }] } });
  assert.equal(record.customer, 'Alice Brooks');
  assert.equal(record.provider, 'agentphone');
  assert.match(record.summary, /Is my truck ready yet/);
});
