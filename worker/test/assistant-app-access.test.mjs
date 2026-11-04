import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { AiChatSession } from '../src/chat-session.mjs';
import { assistantContext, callAppApi, classifyAppApiCall, normalizeAppPath, registeredAppDispatcher } from '../src/assistant/app-api.mjs';
import { executeAssistantTool } from '../src/assistant/tools.mjs';

const SHOP = 'shop-copilot';

function setup(role = 'admin') {
  const DB = createD1();
  DB.sqlite.exec('PRAGMA foreign_keys = OFF');
  const now = new Date().toISOString();
  DB.sqlite.prepare("INSERT INTO shops (id, name, slug, created_at, updated_at) VALUES (?, 'Copilot Garage', 'copilot', ?, ?)").run(SHOP, now, now);
  DB.sqlite.prepare('INSERT INTO users (email, shop_id, role, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(`${role}@copilot.test`, SHOP, role, `Copilot ${role}`, now, now);
  const env = { DB, DEV_AUTH_BYPASS: '1', AI_ENABLED: '1' };
  const context = assistantContext({ shopId: SHOP, userId: `${role}-1`, role, email: `${role}@copilot.test`, name: `Copilot ${role}` });
  return { env, DB, context };
}

const run = (env, context, args, options) => callAppApi(env, context, args, { origin: 'https://app.copilot.test', ...options });

test('the guard: reads and shop records run, deleting is refused, outside effects need the user', () => {
  const verdict = (method, path, body) => classifyAppApiCall({ method, path, body }).decision;
  assert.equal(verdict('GET', '/entities/orders'), 'run');
  assert.equal(verdict('GET', '/api/entities/orders/RO-1?limit=5'), 'run');
  assert.equal(verdict('POST', '/entities/estimates', { customer: 'Dana' }), 'run');
  assert.equal(verdict('PUT', '/entities/orders/RO-1', { status: 'in_progress' }), 'run');
  assert.equal(verdict('POST', '/integrations/labor-guide/search', {}), 'run');
  // Never: deleting in any form.
  assert.equal(verdict('DELETE', '/entities/orders/RO-1'), 'deny');
  assert.equal(verdict('POST', '/entities/orders/RO-1/archive'), 'deny');
  assert.equal(verdict('POST', '/knowledge/items/abc/delete'), 'deny');
  assert.equal(verdict('POST', '/data/reset'), 'deny');
  assert.equal(verdict('POST', '/quickbooks/disconnect'), 'deny');
  assert.equal(verdict('PUT', '/entities/orders/RO-1', { archivedAt: '2026-11-04' }), 'deny');
  assert.equal(verdict('PUT', '/entities/invoices/INV-1', { status: 'void' }), 'deny');
  assert.equal(verdict('GET', '/entities/../auth/session'), 'deny');
  assert.equal(verdict('POST', '/auth/logout'), 'deny');
  assert.equal(verdict('POST', '/ai/assistant', { message: 'loop' }), 'deny');
  // The user confirms: customers, money, access, settings.
  assert.equal(verdict('POST', '/messaging/send', { to: '+1806', body: 'hi' }), 'confirm');
  assert.equal(verdict('POST', '/payments/checkout-session', {}), 'confirm');
  assert.equal(verdict('POST', '/billing/checkout', {}), 'confirm');
  assert.equal(verdict('POST', '/entities/employees', { name: 'New Tech' }), 'confirm');
  assert.equal(verdict('PUT', '/entities/shopsettings/profile', { laborRate: 1 }), 'confirm');
  assert.equal(verdict('POST', '/diagnostics/authorize', {}), 'confirm');
  assert.deepEqual(normalizeAppPath('https://www.shopcrank.com/api/entities/orders?limit=2'), { path: '/entities/orders', search: '?limit=2' });
});

test('the assistant creates, reads and updates records as the user, and an update keeps the other fields', async () => {
  const { env, DB, context } = setup('admin');
  const created = await run(env, context, { method: 'POST', path: '/entities/customers', body: { name: 'Dana Ruiz', phone: '806-555-0144', email: 'dana@example.com', notes: 'Prefers texts' } });
  assert.equal(created.status, 201, JSON.stringify(created));
  const read = await run(env, context, { method: 'GET', path: '/entities/customers/Dana%20Ruiz' });
  assert.equal(read.ok, true);
  assert.equal(read.data.phone, '806-555-0144');
  const updated = await run(env, context, { method: 'PUT', path: '/entities/customers/Dana%20Ruiz', body: { phone: '806-555-0199' } });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const row = JSON.parse(DB.sqlite.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'customers'").get(SHOP).data_json);
  assert.equal(row.phone, '806-555-0199');
  assert.equal(row.email, 'dana@example.com', 'fields the assistant did not send are kept');
  assert.equal(row.notes, 'Prefers texts');
});

test('deleting is refused before and inside the router, and the record stays', async () => {
  const { env, DB, context } = setup('admin');
  await run(env, context, { method: 'POST', path: '/entities/customers', body: { name: 'Keep Me' } });
  const refused = await run(env, context, { method: 'DELETE', path: '/entities/customers/Keep%20Me' });
  assert.equal(refused.denied, true);
  assert.match(refused.message, /not allowed to delete/);
  const archive = await run(env, context, { method: 'PUT', path: '/entities/customers/Keep%20Me', body: { archivedAt: new Date().toISOString() } });
  assert.equal(archive.denied, true);
  // A request that skips the tool layer is stopped by the router itself.
  const routerCall = registeredAppDispatcher();
  for (const [method, path, body] of [
    ['DELETE', '/entities/customers/Keep%20Me', null],
    ['PUT', '/entities/customers/Keep%20Me', { name: 'Keep Me', archivedAt: '2026-11-04' }],
    ['POST', '/messaging/send', { to: '+18065550144', body: 'hi' }],
  ]) {
    const response = await routerCall(new Request(`https://app.copilot.test/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, context);
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  const row = DB.sqlite.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'customers'").get(SHOP);
  assert.ok(row && !JSON.parse(row.data_json).archivedAt);
});

test('same access as the user: a technician cannot write invoices through the assistant either', async () => {
  const { env, context } = setup('technician');
  const result = await run(env, context, { method: 'POST', path: '/entities/invoices', body: { number: 'INV-9001', customer: 'Dana', amount: 100 } });
  assert.equal(result.status, 403);
  assert.match(JSON.stringify(result.data), /cannot modify invoices/);
  const allowed = await run(env, context, { method: 'POST', path: '/entities/vehicles', body: { customer: 'Dana', year: '2018', make: 'Toyota', model: 'Camry' } });
  assert.equal(allowed.status, 201);
});

test('texting a customer comes back as a card to confirm; voice is told to use the screen', async () => {
  const { env, context } = setup('admin');
  const card = await run(env, context, { method: 'POST', path: '/messaging/send', body: { to: '+18065550144', body: 'Your truck is ready' }, summary: 'Text Dana that the truck is ready' });
  assert.equal(card.kind, 'app_api_confirmation');
  assert.equal(card.requiresUserReview, true);
  assert.equal(card.saved, false);
  assert.deepEqual([card.method, card.path], ['POST', '/messaging/send']);
  assert.equal(card.summary, 'Text Dana that the truck is ready');
  const voice = await run(env, context, { method: 'POST', path: '/messaging/send', body: {} }, { channel: 'voice' });
  assert.equal(voice.error, 'needs_confirmation');
  const asText = await run(env, context, { method: 'POST', path: '/entities/customers', body: '{"name":"From Text"}' });
  assert.equal(asText.status, 201, 'a JSON-text body (Gemini) works too');
});

test('the tool layer: shopcrank_api needs the app context, and help and screens follow the role', async () => {
  const { env, context } = setup('technician');
  const without = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'shopcrank_api', args: { method: 'GET', path: '/entities/orders' }, channel: 'text' });
  assert.match(without.error, /not available/);
  const withApp = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'shopcrank_api', args: { method: 'GET', path: '/entities/orders' }, channel: 'text', app: { context, origin: 'https://app.copilot.test' } });
  assert.equal(withApp.status, 200);
  const help = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'get_app_help', args: { question: 'how do I clock in to a job' }, channel: 'text' });
  assert.ok(help.topics.length > 0);
  assert.ok(help.topics.every(topic => topic.screen && Array.isArray(topic.steps)));
  const screen = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'open_screen', args: { screen: 'orders' }, channel: 'text' });
  assert.equal(screen.kind, 'open_screen');
  const payroll = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'office', name: 'open_screen', args: { screen: 'superadmin' }, channel: 'text' });
  assert.match(payroll.error, /cannot open/);
  const voiceScreen = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'open_screen', args: { screen: 'orders' }, channel: 'voice' });
  assert.equal(voiceScreen.denied, true);
  const reference = await executeAssistantTool(env, { shopId: SHOP, persona: 'tech_assistant', role: 'technician', name: 'get_api_reference', args: {}, channel: 'text' });
  assert.equal(reference.entities.find(item => item.type === 'invoices').write, false);
  assert.equal(reference.entities.find(item => item.type === 'orders').write, true);
  const frontDesk = await executeAssistantTool(env, { shopId: SHOP, persona: 'front_desk', name: 'shopcrank_api', args: { method: 'GET', path: '/entities/orders' }, channel: 'voice' });
  assert.equal(frontDesk.denied, true, 'the phone receptionist never gets program access');
});

function chatNamespace(env) {
  const sessions = new Map();
  return {
    idFromName: name => name,
    get(id) {
      if (!sessions.has(id)) {
        const values = new Map();
        sessions.set(id, new AiChatSession({ storage: { get: async key => values.get(key), put: async (key, value) => { values.set(key, value); } } }, env));
      }
      return sessions.get(id);
    },
  };
}

test('end to end: the included AI builds and saves an estimate, cannot delete, and a text needs confirming', async () => {
  const { env, DB } = setup('admin');
  const runs = [];
  const steps = [
    { tool_calls: [{ name: 'shopcrank_api', arguments: { method: 'POST', path: '/entities/estimates', body: { number: 'EST-2026-0001', customer: 'Dana Ruiz', vehicle: '2018 Toyota Camry', status: 'pending', lines: [{ type: 'labor', description: 'Replace starter', hours: 2.2, unitPrice: 140, total: 308 }], total: 308 }, summary: 'Save the starter estimate' } }] },
    { tool_calls: [{ name: 'shopcrank_api', arguments: { method: 'DELETE', path: '/entities/estimates/EST-2026-0001' } }] },
    { tool_calls: [{ name: 'shopcrank_api', arguments: JSON.stringify({ method: 'POST', path: '/messaging/send', body: { to: '+18065550144', body: 'Estimate ready' }, summary: 'Text Dana the estimate' }) }] },
    { response: 'Saved EST-2026-0001 for $308. I cannot delete estimates. Tap Confirm to text Dana.' },
  ];
  env.AI = { async run(model, input) { runs.push(input); return steps[runs.length - 1]; } };
  env.AI_CHAT_SESSIONS = chatNamespace(env);
  const response = await worker.fetch(new Request('https://app.copilot.test/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ShopCrank-Dev-Email': 'admin@copilot.test' },
    body: JSON.stringify({ message: 'Build an estimate for Dana Ruiz, starter on her 2018 Camry, then text her.' }),
  }), env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.provider, 'workers-ai');
  assert.match(payload.message, /EST-2026-0001/);
  const saved = DB.sqlite.prepare("SELECT data_json FROM entities WHERE shop_id = ? AND entity_type = 'estimates'").get(SHOP);
  assert.equal(JSON.parse(saved.data_json).total, 308);
  const toolMessages = runs[3].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(toolMessages[0].status, 201);
  assert.equal(toolMessages[1].denied, true);
  assert.equal(toolMessages[2].kind, 'app_api_confirmation');
  assert.equal(payload.actions.length, 1);
  assert.equal(payload.actions[0].kind, 'app_api_confirmation');
  assert.equal(payload.actions[0].path, '/messaging/send');
  assert.ok(runs[0].tools.some(tool => tool.name === 'search_web'));
  assert.match(runs[0].messages[0].content, /never delete/i);
});
