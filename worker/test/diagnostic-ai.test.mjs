import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDiagnosticAnalysis } from '../src/index.js';

function analysisEnv({ order = null, assistant } = {}) {
  const audits = [];
  const turns = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes('FROM entities') && order && args[2] === order.id) return { data_json: JSON.stringify(order) };
              if (sql.includes('FROM ai_rate_limits')) return { request_count: 1 };
              return null;
            },
            run: async () => {
              if (sql.includes('INSERT INTO audit_log')) audits.push(JSON.parse(args[4]));
              return {};
            },
          };
        },
      };
    },
  };
  const AI_CHAT_SESSIONS = {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        const body = await request.json();
        turns.push({ body, shopId: request.headers.get('X-MechPro-Shop-Id') });
        return Response.json(assistant || {
          message: 'Most likely cause: failed ignition coil on cylinder 3.',
          actions: [{ kind: 'estimate_work_order_draft', draft: { labor: [{ description: 'Misfire diagnosis', hours: 1 }], parts: [{ description: 'Ignition coil', quantity: 1, unitPrice: 0 }] } }],
          model: 'test-model',
          sessionId: 'session-1',
        });
      },
    }),
  };
  return { env: { DB, AI_ENABLED: '1', AI_CHAT_SESSIONS }, audits, turns };
}

const tech = { shopId: 'shop-1', userId: 'tech-1', email: 't@example.test', role: 'technician' };
const order = { id: 'RO-1050', customer: 'Pat Driver', phone: '555-0100', vehicle: '2019 Ram 1500 5.7L', vin: '1C6SRFHT0LN123456', complaint: 'Shakes at idle' };
const analyze = body => new Request('https://x/api/diagnostics/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('scan codes go to the assistant with the RO context and come back with a draft', async () => {
  const { env, audits, turns } = analysisEnv({ order });
  const response = await handleDiagnosticAnalysis(analyze({
    orderId: 'RO-1050', scanId: 'scan-1', milOn: true,
    dtcs: [{ code: 'P0303', description: 'Stored' }, { code: 'p0300', description: 'Pending' }, { code: 'BAD' }],
    readings: [{ name: 'RPM', value: 650, unit: 'rpm' }],
  }), env, tech, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.dtcs.map(item => item.code), ['P0303', 'P0300']);
  assert.deepEqual(body.invalidCodes, ['BAD']);
  assert.equal(body.actions[0].kind, 'estimate_work_order_draft');
  const message = turns[0].body.message;
  assert.equal(turns[0].shopId, 'shop-1');
  assert.match(message, /P0303 \(stored, Powertrain, generic \(SAE\)\)/);
  assert.match(message, /2019 Ram 1500 5\.7L · VIN 1C6SRFHT0LN123456/);
  assert.match(message, /Shakes at idle/);
  assert.match(message, /prepare_estimate_work_order/);
  assert.doesNotMatch(message, /555-0100/);
  assert.ok(message.length <= 4000);
  assert.deepEqual(audits[0], { kind: 'diagnostics.ai_analyze', orderId: 'RO-1050', scanId: 'scan-1', codes: ['P0303', 'P0300'], model: 'test-model' });
});

test('analysis requires evidence, an existing RO, and enabled AI', async () => {
  const { env } = analysisEnv({ order });
  await assert.rejects(handleDiagnosticAnalysis(analyze({ dtcs: [] }), env, tech, {}), error => error.status === 400);
  await assert.rejects(handleDiagnosticAnalysis(analyze({ orderId: 'RO-404', dtcs: ['P0300'] }), env, tech, {}), error => error.status === 404);
  await assert.rejects(handleDiagnosticAnalysis(analyze({ dtcs: ['P0300'] }), { ...env, AI_ENABLED: '0' }, tech, {}), error => error.status === 503);
});
