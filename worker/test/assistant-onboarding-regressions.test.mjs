import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { executeAssistantTool, buildPersonaSession } from '../src/assistant/tools.mjs';
import { putShopEntity, putShopSetting } from '../src/shop-settings-store.mjs';
import { createOnboarding, saveOnboarding } from '../src/onboarding/store.mjs';
import { renderFrontDeskTemplate } from '../../src/modules/front-desk-questionnaire.js';

const tech = (env, name, args = {}, role = 'technician') => executeAssistantTool(env, { shopId: 'shop-1', persona: 'tech_assistant', role, name, args });
const front = (env, name, args = {}) => executeAssistantTool(env, { shopId: 'shop-1', persona: 'front_desk', name, args, callerPhone: '+18065550123' });

test('record search trims, lowercases and drops blanks before accounting filters; explicit empty never widens scope', async () => {
  const env = { DB: createD1() };
  await putShopEntity(env, 'shop-1', 'orders', 'order-1', { customer: 'Visible', margin: 999 });
  await putShopEntity(env, 'shop-1', 'invoices', 'invoice-1', { customer: 'Private' });
  await putShopEntity(env, 'shop-1', 'payrollentries', 'payroll-1', { employee: 'Private' });
  for (const types of [[], [''], ['  '], [' Invoices '], [' PAYROLLENTRIES ', '  '], ['invoices', '', 'payments']]) {
    const result = await tech(env, 'search_shop_records', { query: '', types });
    assert.equal(result.count, 0, JSON.stringify(types));
    assert.deepEqual(result.records, []);
  }
  const result = await tech(env, 'search_shop_records', { query: 'Visible', types: [' ORDERS ', ' invoices ', ''] });
  assert.equal(result.count, 1);
  assert.doesNotMatch(JSON.stringify(result), /Private|"margin"/);
  assert.equal((await tech(env, 'search_shop_records', { types: [] }, 'owner')).count, 0);
});

test('verified callers only see orders linked by customer ID, not duplicate customer names', async () => {
  const env = { DB: createD1() };
  await putShopSetting(env, 'shop-1', 'front_desk_questionnaire', { answers: { vehicleStatusLookup: true } });
  await putShopEntity(env, 'shop-1', 'customers', 'mine', { name: 'Alex Smith', phone: '+18065550123' });
  await putShopEntity(env, 'shop-1', 'customers', 'other', { name: 'Alex Smith', phone: '+18065550124' });
  await putShopEntity(env, 'shop-1', 'orders', 'mine-order', { customerId: 'mine', customer: 'Alex Smith', vehicle: 'Own car', status: 'working' });
  await putShopEntity(env, 'shop-1', 'orders', 'other-order', { customerId: 'other', customer: 'Alex Smith', vehicle: 'Private car', status: 'working' });
  await putShopEntity(env, 'shop-1', 'orders', 'legacy', { customer: 'Alex Smith', vehicle: 'Unverified car', status: 'working' });
  const result = await front(env, 'check_my_vehicle_status');
  assert.equal(result.verified, true);
  assert.deepEqual(result.vehicles.map(item => item.vehicle), ['Own car']);
});

test('labor tool does not invent fallback hours when a licensed numeric time is unavailable', async () => {
  for (const operation of ['unknown job', 'front brake pads', 'oil change']) {
    const result = await tech({}, 'lookup_labor_time', { operation });
    assert.deepEqual(result.operations, []);
    assert.equal(result.source, 'unavailable');
  }
});

test('labor tool returns only finite verified numeric hours from a configured guide', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [
    { hours: 2.5, description: 'Front brakes' },
    { hours: 'not available', description: 'No time' },
    { hours: null, description: 'Missing time' },
  ] }));
  const result = await tech({
    MOTOR_LABOR_BASE_URL: 'https://labor.example.com', MOTOR_LABOR_SEARCH_PATH: '/search',
    MOTOR_LABOR_API_KEY: 'test-only', MOTOR_LABOR_LICENSE_CONFIRMED: 'true',
  }, 'lookup_labor_time', { operation: 'front brakes' });
  assert.equal(result.source, 'licensed_labor_guide');
  assert.deepEqual(result.operations.map(item => item.hours), [2.5]);
});

test('financial report uses payment receivedAt and payroll reads payrollentries', async () => {
  const env = { DB: createD1() };
  await putShopEntity(env, 'shop-1', 'payments', 'paid', { amount: 125, receivedAt: '2026-10-12', createdAt: '2026-09-01' });
  await putShopEntity(env, 'shop-1', 'payments', 'outside', { amount: 500, receivedAt: '2026-09-12', createdAt: '2026-10-12' });
  await putShopEntity(env, 'shop-1', 'payrollentries', 'pay', { period: '2026-10', gross: 1000 });
  assert.equal((await tech(env, 'get_financial_report', { from: '2026-10-01', to: '2026-10-31' }, 'owner')).collected, 125);
  assert.equal((await tech(env, 'get_payroll_summary', { period: '2026-10' }, 'owner')).records.length, 1);
  assert.equal((await tech(env, 'get_payroll_summary')).denied, true);
});

test('pricing tool follows questionnaire, intake, profile precedence and respects publish permission', async () => {
  const env = { DB: createD1() };
  await putShopSetting(env, 'shop-1', 'profile', { laborRate: 140 });
  const onboarding = await createOnboarding(env, { shopId: 'shop-1', intake: { laborRate: 160 } });
  for (const [answers, rate] of [[{ laborRate: 180, publishLaborRate: true }, 180], [{ publishLaborRate: true }, 160]]) {
    await putShopSetting(env, 'shop-1', 'front_desk_questionnaire', { answers });
    const result = await front(env, 'answer_pricing_question', { service: 'brakes' });
    assert.equal(result.laborRatePerHour, rate);
    assert.match(renderFrontDeskTemplate({ ...answers, laborRate: rate }), new RegExp(`\\$${rate}\\.00`));
  }
  onboarding.intake = { laborRate: null };
  await saveOnboarding(env, onboarding);
  assert.equal((await front(env, 'answer_pricing_question')).laborRatePerHour, 140);
  await putShopSetting(env, 'shop-1', 'front_desk_questionnaire', { answers: { publishLaborRate: false, laborRate: 180 } });
  assert.equal((await front(env, 'answer_pricing_question')).laborRatePerHour, undefined);
});

test('callback messages appear in staff call history and notify configured staff without exposing targets', async () => {
  const deliveries = [];
  const env = { DB: createD1(), SUPPORT_EMAIL_FROM: 'support@example.com', EMAIL: { send: async mail => deliveries.push(mail) } };
  await putShopSetting(env, 'shop-1', 'front_desk_questionnaire', { answers: { notifyEmails: ['advisor@example.com'] } });
  const result = await front(env, 'take_message', { name: 'Caller', message: 'Please call me about my brakes' });
  assert.equal(result.saved, true);
  assert.equal(result.staffNotified, true);
  assert.doesNotMatch(JSON.stringify(result), /advisor@example/);
  const call = JSON.parse((await env.DB.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'calls' AND entity_id = ?").bind('shop-1', result.reference).first()).data_json);
  assert.match(call.summary, /Please call me/);
  assert.equal(call.outcome, 'callback_requested');
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].text, /Please call me/);
});

test('front desk sessions retain opt-in PR157 calendar tools without exposing technical or accounting tools', async () => {
  for (const enabled of ['', '1']) {
    const session = await buildPersonaSession({ AI_PHONE_BOOKING_ENABLED: enabled }, { shopId: 'shop-1', persona: 'front_desk' });
    assert.equal(session.tools.some(tool => tool.name === 'book_appointment'), enabled === '1');
    assert.equal(session.tools.some(tool => tool.name === 'get_financial_report'), false);
    assert.equal(session.tools.some(tool => tool.name === 'lookup_dtc'), false);
  }
});
