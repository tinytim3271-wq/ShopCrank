/** Platform console: dependency health check (GET/POST /api/admin/health-check). */

const STATUS_BADGE = { ok: 'paid', degraded: 'estimate', down: 'overdue', not_configured: '', skipped: '' };
const STATUS_LABEL = { ok: 'OK', degraded: 'Degraded', down: 'Down', not_configured: 'Not configured', skipped: 'Skipped' };
const STATUS_ORDER = { down: 0, degraded: 1, ok: 2, not_configured: 3, skipped: 4 };

function badge(status, escapeHtml) {
  return `<span class="badge ${STATUS_BADGE[status] ?? ''}">${escapeHtml(STATUS_LABEL[status] || status || '')}</span>`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '';
}

/** Probe and canary rows from a run, failures first. */
export function healthRows(run) {
  if (!run) return [];
  const probes = (run.probes || []).map(item => ({
    check: item.probe,
    dependency: item.dependency,
    shopId: item.shopId || '',
    status: item.status,
    latencyMs: item.latencyMs,
    message: item.error?.message || item.detail || '',
    issues: item.error?.issues || [],
  }));
  const canaries = (run.canaries || []).map(item => ({
    check: item.tool,
    dependency: 'tool-contract',
    shopId: item.shopId || '',
    status: item.status,
    latencyMs: item.latencyMs,
    message: item.error?.message || '',
    issues: item.error?.issues || [],
  }));
  return [...probes, ...canaries].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
}

/** Rebuild a run summary from stored JSONL entries (one per tool and dependency). */
export function runFromEntries(entries = []) {
  const first = entries[0] || {};
  const probes = new Map();
  const canaries = [];
  for (const entry of entries) {
    if (entry.dependency === 'tool-contract') {
      canaries.push({ tool: entry.tool, shopId: entry.shopId, status: entry.status, latencyMs: entry.latencyMs, error: entry.error });
      continue;
    }
    const key = `${entry.probe}|${entry.shopId || ''}`;
    if (!probes.has(key)) {
      probes.set(key, { dependency: entry.dependency, probe: entry.probe, shopId: entry.shopId, status: entry.status, latencyMs: entry.latencyMs, error: entry.error, detail: entry.detail });
    }
  }
  const all = [...probes.values(), ...canaries];
  return {
    runId: first.runId || '',
    trigger: first.trigger || '',
    dryRun: Boolean(first.dryRun),
    contractVersion: first.contractVersion || '',
    startedAt: first.timestamp || '',
    ok: !all.some(item => item.status === 'down' || item.status === 'degraded'),
    probes: [...probes.values()],
    canaries,
    entries,
  };
}

/** JSONL text for a run's entries (what the Worker stores in R2). */
export function runJsonl(run) {
  const entries = run?.entries || [];
  return entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
}

function countsText(counts) {
  if (!counts) return '';
  return Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => `${STATUS_LABEL[status] || status} ${count}`).join(' · ');
}

function issuesText(issues) {
  return issues.slice(0, 3).map(issue => `${issue.path} ${issue.problem} (expected ${issue.expected}, got ${issue.actual})`).join('; ');
}

export function healthCheckHtml(data, { escapeHtml, icon }) {
  if (!data?.overview) return '<p>Loading health checks…</p>';
  const { overview, run = null, running = false } = data;
  const rows = healthRows(run);
  const failing = rows.filter(row => row.status === 'down' || row.status === 'degraded').length;
  const kpis = run
    ? `<div class="platform-kpis"><article><span>Last run</span><strong>${run.ok ? 'Healthy' : 'Failing'}</strong></article><article><span>Failing checks</span><strong>${failing}</strong></article><article><span>Checks</span><strong>${rows.length}</strong></article><article><span>Contract</span><strong>v${escapeHtml(run.contractVersion || overview.contractVersion)}</strong></article></div>`
    : '';
  const runRows = rows.map(row => `<tr><td><b>${escapeHtml(row.check)}</b><small>${escapeHtml(row.dependency)}</small></td><td>${badge(row.status, escapeHtml)}</td><td class="mono">${escapeHtml(row.shopId)}</td><td class="mono">${Number.isFinite(row.latencyMs) ? `${row.latencyMs} ms` : ''}</td><td>${escapeHtml(row.message)}${row.issues.length ? `<small class="mono">${escapeHtml(issuesText(row.issues))}</small>` : ''}</td></tr>`).join('');
  const history = (overview.runs || []).map(item => `<tr><td class="mono">${escapeHtml(formatDateTime(item.startedAt))}</td><td>${badge(item.ok ? 'ok' : 'down', escapeHtml)}</td><td>${escapeHtml(item.trigger)}</td><td>${escapeHtml(countsText(item.counts))}</td><td><button class="mini-action" type="button" data-health-run="${escapeHtml(item.name)}">${icon('eye', 13)} View</button><button class="mini-action" type="button" data-health-download="${escapeHtml(item.name)}">${icon('download', 13)} JSONL</button></td></tr>`).join('');
  const current = run
    ? `<h2>${run.dryRun ? 'Dry run' : 'Run'} · <span class="mono">${escapeHtml(formatDateTime(run.startedAt))}</span>${run.trigger ? ` · ${escapeHtml(run.trigger)}` : ''}</h2>${run.storage?.key ? `<p class="ops-note">Stored as <span class="mono">${escapeHtml(run.storage.key)}</span></p>` : ''}<div class="platform-action-buttons"><button class="mini-action" type="button" id="health-download-current">${icon('download', 13)} Download JSONL</button></div><div class="data-panel"><table><thead><tr><th>Check</th><th>Status</th><th>Shop</th><th>Latency</th><th>Detail</th></tr></thead><tbody>${runRows || '<tr><td colspan="5">No checks ran.</td></tr>'}</tbody></table></div>`
    : '<p class="ops-note">Run a dry run to validate configuration without calling QuickBooks, Stripe or PartsTech, or a full run to ping every dependency.</p>';
  const latestChange = overview.changelog?.[0];
  return `${kpis}<div class="access-note platform-security">${icon('activity', 15)} Pings D1, the inventory service (D1 inventory records and each shop's PartsTech connection), QuickBooks Online and Stripe webhooks, and checks every assistant tool's output against contract v${escapeHtml(overview.contractVersion)}. Scheduled <span class="mono">${escapeHtml(overview.schedule)}</span> (UTC); failures are emailed (${escapeHtml(overview.emailMode)}).</div><div class="platform-action-buttons"><button class="secondary" type="button" id="health-dry-run" ${running ? 'disabled' : ''}>${icon('flask-conical', 15)} Dry run</button><button class="primary" type="button" id="health-run-now" ${running ? 'disabled' : ''}>${icon('activity', 15)} ${running ? 'Running…' : 'Run full check'}</button></div>${current}<h2>Recent runs</h2><div class="data-panel"><table><thead><tr><th>Started</th><th>Result</th><th>Trigger</th><th>Counts</th><th></th></tr></thead><tbody>${history || '<tr><td colspan="5">No stored runs yet. Dry runs are never stored.</td></tr>'}</tbody></table></div>${latestChange ? `<h2>Tool contract changelog</h2><div class="data-panel"><table><thead><tr><th>Version</th><th>Date</th><th>Changes</th></tr></thead><tbody>${(overview.changelog || []).map(entry => `<tr><td class="mono">v${escapeHtml(entry.version)}</td><td class="mono">${escapeHtml(entry.date)}</td><td>${entry.changes.map(change => escapeHtml(change)).join('<br>')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
