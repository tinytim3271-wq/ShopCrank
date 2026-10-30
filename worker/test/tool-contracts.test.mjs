import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1-sqlite.mjs';
import { PERSONA_TOOL_NAMES, executeAssistantTool } from '../src/assistant/tools.mjs';
import { PERSONAS } from '../src/assistant/personas.mjs';
import { GROK_BOOKING_TOOLS } from '../src/grok-voice.mjs';
import {
  TOOL_CONTRACTS,
  TOOL_CONTRACTS_CHANGELOG,
  TOOL_CONTRACTS_VERSION,
  toolsUsingDependency,
} from '../src/health/tool-contracts.mjs';
import { checkToolOutput, validateShape } from '../src/health/schema.mjs';
import { redactToolInput, serializeError } from '../src/redact.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const compareSemver = (a, b) => {
  const [x, y] = [a, b].map(value => value.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function captureConsole(method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console[method] = original; } };
}

test('every registered assistant tool has a contract and every contract names a real tool', () => {
  const registered = new Set([
    ...PERSONA_TOOL_NAMES[PERSONAS.TECH],
    ...PERSONA_TOOL_NAMES[PERSONAS.FRONT_DESK],
    ...GROK_BOOKING_TOOLS.map(tool => tool.name),
  ]);
  const contracted = new Set(Object.keys(TOOL_CONTRACTS));
  assert.deepEqual([...registered].filter(name => !contracted.has(name)), [], 'tools missing from tool-contracts.mjs');
  assert.deepEqual([...contracted].filter(name => !registered.has(name)), [], 'contracts for tools that no longer exist');
});

test('the contract changelog is versioned and covers every contract', () => {
  assert.match(TOOL_CONTRACTS_VERSION, SEMVER);
  const versions = TOOL_CONTRACTS_CHANGELOG.map(entry => entry.version);
  versions.forEach(version => assert.match(version, SEMVER));
  assert.deepEqual([...versions].sort(compareSemver).reverse(), versions, 'changelog must be newest first');
  assert.equal(versions[0], TOOL_CONTRACTS_VERSION, 'bump TOOL_CONTRACTS_VERSION with each changelog entry');
  for (const entry of TOOL_CONTRACTS_CHANGELOG) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.changes.length > 0);
  }
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    assert.ok(versions.includes(contract.since), `${name}.since must be a changelog version`);
    assert.ok(contract.summary, `${name} needs a summary`);
    assert.ok(contract.returns && typeof contract.returns === 'object', `${name} needs a returns shape`);
    assert.ok(Array.isArray(contract.dependencies));
  }
  assert.ok(toolsUsingDependency('inventory').includes('lookup_parts'));
  assert.ok(toolsUsingDependency('quickbooks').includes('request_quickbooks_sync'));
});

test('validateShape reports missing fields, wrong types and enum drift', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'integer' }, total: { type: 'number' }, kind: { type: 'string', enum: ['draft'] }, rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    required: ['count', 'kind'],
  };
  assert.deepEqual(validateShape(schema, { count: 2, total: 3, kind: 'draft', rows: [{ id: 'a' }] }), []);
  const issues = validateShape(schema, { count: 1.5, total: '3', kind: 'saved', rows: [{}] });
  assert.deepEqual(issues.map(issue => `${issue.path}:${issue.problem}`).sort(), [
    '$.count:type', '$.kind:enum', '$.rows[0].id:missing', '$.total:type',
  ]);
  assert.deepEqual(validateShape(schema, { kind: 'draft' }).map(issue => issue.path), ['$.count']);
  assert.equal(validateShape({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 })[0].problem, 'unexpected');
  const either = { anyOf: [{ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, { type: 'string' }] };
  assert.deepEqual(validateShape(either, 'fine'), []);
  assert.deepEqual(validateShape(either, { ok: true }), []);
  assert.equal(validateShape(either, { ok: 'yes' })[0].path, '$.ok');
});

test('checkToolOutput separates the error envelope from schema drift', () => {
  assert.equal(checkToolOutput('prepare_refund', { kind: 'refund_draft', invoiceNumber: 'A', amount: 1, reason: '', requiresUserReview: true, saved: false }).kind, 'ok');
  assert.equal(checkToolOutput('prepare_refund', { error: 'nope' }).kind, 'error');
  const drift = checkToolOutput('prepare_refund', { kind: 'refund_draft', invoiceNumber: 'A', amount: '1', reason: '', requiresUserReview: true, saved: false });
  assert.equal(drift.kind, 'drift');
  assert.equal(drift.version, TOOL_CONTRACTS_VERSION);
  assert.deepEqual(drift.issues.map(issue => issue.path), ['$.amount']);
  assert.equal(checkToolOutput('made_up_tool', {}).kind, 'uncontracted');
});

function seededEnv() {
  const DB = createD1();
  const put = (type, id, data) => DB.sqlite.prepare(
    "INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at) VALUES ('healthcheck-canary', ?, ?, ?, 'test', ?, ?)",
  ).run(type, id, JSON.stringify({ id, ...data }), new Date().toISOString(), new Date().toISOString());
  put('inventory', 'part-1', { description: 'healthcheck-canary oil filter', quantity: 4, cost: 3.5 });
  put('orders', 'RO-1', { customer: 'healthcheck-canary', vehicle: '2020 Civic', status: 'in progress', notes: 'P0301 misfire' });
  put('invoices', 'INV-1', { number: 'INV-1', amount: 120, date: '2026-01-10' });
  put('payments', 'PAY-1', { amount: 100, receivedAt: '2026-01-11' });
  return { DB };
}

test('every non-network canary returns output that matches its contract on a real D1 schema', async () => {
  const env = seededEnv();
  const failures = [];
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    if (!contract.canary || contract.canary.network) continue;
    const { persona, role = '', args } = contract.canary;
    const result = await executeAssistantTool(env, { shopId: 'healthcheck-canary', persona, role, name, args });
    const check = checkToolOutput(name, result);
    if (check.kind !== 'ok') failures.push({ name, kind: check.kind, issues: check.issues, result });
  }
  assert.deepEqual(failures, []);
});

test('executeAssistantTool logs the tool, redacted input and full error when a tool throws, then rethrows', async () => {
  const env = { DB: { prepare() { throw new Error('D1_ERROR: no such table: entities'); } } };
  const logged = captureConsole('error');
  try {
    await assert.rejects(
      executeAssistantTool(env, { shopId: 'shop-1', persona: PERSONAS.TECH, role: 'admin', name: 'lookup_customer', args: { query: 'call jane@example.com at 806-555-0101', name: 'Jane Doe' } }),
      /no such table/,
    );
  } finally {
    logged.restore();
  }
  const entry = JSON.parse(logged.lines.find(line => line.includes('assistant tool failed')));
  assert.equal(entry.tool, 'lookup_customer');
  assert.equal(entry.shopId, 'shop-1');
  assert.equal(entry.input.name, '[REDACTED]');
  assert.equal(entry.input.query, 'call [EMAIL] at [PHONE]');
  assert.equal(entry.error.name, 'Error');
  assert.match(entry.error.message, /no such table/);
  assert.match(entry.error.stack, /lookup|tools\.mjs|ai\.mjs/);
  assert.ok(Number.isFinite(entry.latencyMs));
});

test('executeAssistantTool surfaces soft { error } results instead of letting them pass silently', async () => {
  const warned = captureConsole('warn');
  let result;
  try {
    result = await executeAssistantTool({ DB: createD1() }, { shopId: 'shop-1', persona: PERSONAS.TECH, role: 'admin', name: 'lookup_dtc', args: { code: 'nonsense' } });
  } finally {
    warned.restore();
  }
  assert.match(result.error, /OBD-II/);
  const entry = JSON.parse(warned.lines.find(line => line.includes('assistant tool returned error')));
  assert.equal(entry.tool, 'lookup_dtc');
  assert.equal(entry.input.code, 'nonsense');
  assert.match(entry.error, /OBD-II/);
  assert.equal(entry.contractVersion, TOOL_CONTRACTS_VERSION);
});

test('redactToolInput hides secrets and personal data; serializeError keeps the cause chain', () => {
  const redacted = redactToolInput({
    apiKey: 'sk_live_123', password: 'hunter2', phone: '8065550101', email: 'a@b.co', vin: '1HGCM82633A004352',
    customer: { name: 'Jane', note: 'reach me at a@b.co' }, operation: 'brakes', items: ['x'.repeat(500)], emptyName: '',
  });
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.phone, '[REDACTED]');
  assert.equal(redacted.email, '[REDACTED]');
  assert.equal(redacted.vin, '[REDACTED]');
  assert.equal(redacted.customer, '[REDACTED]');
  assert.equal(redacted.operation, 'brakes');
  assert.ok(redacted.items[0].length <= 201);
  const error = serializeError(new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'E_INNER' }) }));
  assert.equal(error.cause.message, 'inner');
  assert.equal(error.cause.code, 'E_INNER');
  assert.deepEqual(serializeError('plain'), { message: 'plain' });
});
