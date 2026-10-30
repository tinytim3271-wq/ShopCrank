import test from 'node:test';
import assert from 'node:assert/strict';
import { healthCheckHtml, healthRows, runFromEntries, runJsonl } from './health-check.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<i data-lucide="${name}"></i>`;

const entries = [
  { timestamp: '2026-10-30T06:30:00.000Z', runId: 'run-1', trigger: 'cron', dryRun: false, contractVersion: '1.0.0', tool: 'lookup_job', dependency: 'd1', probe: 'd1.select', shopId: null, status: 'ok', latencyMs: 3, error: null },
  { timestamp: '2026-10-30T06:30:00.000Z', runId: 'run-1', trigger: 'cron', dryRun: false, contractVersion: '1.0.0', tool: 'lookup_parts', dependency: 'd1', probe: 'd1.select', shopId: null, status: 'ok', latencyMs: 3, error: null },
  { timestamp: '2026-10-30T06:30:01.000Z', runId: 'run-1', trigger: 'cron', dryRun: false, contractVersion: '1.0.0', tool: 'request_quickbooks_sync', dependency: 'quickbooks', probe: 'quickbooks.companyinfo', shopId: 'shop-1', status: 'down', latencyMs: 412, error: { message: 'token <revoked>' } },
  { timestamp: '2026-10-30T06:30:02.000Z', runId: 'run-1', trigger: 'cron', dryRun: false, contractVersion: '1.0.0', tool: 'get_financial_report', dependency: 'tool-contract', probe: 'canary', shopId: 'healthcheck-canary', status: 'degraded', latencyMs: 8, error: { message: 'Output drifted from contract v1.0.0', code: 'schema_drift', issues: [{ path: '$.invoiced', problem: 'type', expected: 'number', actual: 'string' }] } },
];

test('runFromEntries collapses per-tool lines back into one row per probe', () => {
  const run = runFromEntries(entries);
  assert.equal(run.runId, 'run-1');
  assert.equal(run.ok, false);
  assert.equal(run.probes.length, 2);
  assert.equal(run.canaries.length, 1);
  assert.equal(runJsonl(run).trimEnd().split('\n').length, entries.length);
  assert.equal(runJsonl({ entries: [] }), '');
});

test('healthRows lists failures first with drift issues attached', () => {
  const rows = healthRows(runFromEntries(entries));
  assert.deepEqual(rows.map(row => row.status), ['down', 'degraded', 'ok']);
  assert.equal(rows[1].issues[0].path, '$.invoiced');
  assert.deepEqual(healthRows(null), []);
});

test('healthCheckHtml renders the run, history and changelog with escaped content', () => {
  const overview = {
    schedule: '30 0,6,12,18 * * *',
    contractVersion: '1.0.0',
    emailMode: 'failures',
    changelog: [{ version: '1.0.0', date: '2026-10-30', changes: ['Initial <contract>'] }],
    runs: [{ name: '0000000000001-run-1', runId: 'run-1', trigger: 'cron', ok: false, startedAt: '2026-10-30T06:30:00Z', counts: { ok: 2, down: 1 } }],
  };
  assert.match(healthCheckHtml(null, { escapeHtml, icon }), /Loading/);
  const html = healthCheckHtml({ overview, run: runFromEntries(entries) }, { escapeHtml, icon });
  assert.match(html, /Failing/);
  assert.match(html, /quickbooks\.companyinfo/);
  assert.match(html, /token &lt;revoked&gt;/);
  assert.doesNotMatch(html, /<revoked>|<contract>/);
  assert.match(html, /\$\.invoiced type \(expected number, got string\)/);
  assert.match(html, /data-health-run="0000000000001-run-1"/);
  assert.match(html, /id="health-dry-run"/);
  assert.match(html, /v1\.0\.0/);
  const running = healthCheckHtml({ overview: { ...overview, runs: [] }, running: true }, { escapeHtml, icon });
  assert.match(running, /Running…/);
  assert.match(running, /No stored runs yet/);
  assert.match(running, /id="health-run-now" disabled/);
});
