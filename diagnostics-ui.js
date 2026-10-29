/** Dodge/Ram OEM Diagnostics module — Phase 1 diagnostic-only prototype. */

const OEM_DIAG_STATE_KEY = 'shopcrank-oem-diagnostics-v1';

function loadOemDiagState() {
  try {
    return JSON.parse(localStorage.getItem(OEM_DIAG_STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveOemDiagState(patch) {
  const current = loadOemDiagState();
  localStorage.setItem(OEM_DIAG_STATE_KEY, JSON.stringify({ ...current, ...patch }));
}

function oemDiagApi() {
  return window.shopcrankDiagnostics;
}

function isOemDiagnosticsAvailable() {
  return Boolean(window.shopcrankDiagnostics);
}

function vinModelYearFromCode(vin) {
  const value = String(vin || '').toUpperCase();
  if (value.length < 10) return 0;
  const codes = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const index = codes.indexOf(value[9]);
  if (index < 0) return 0;
  const baseYear = 1980 + index;
  return /[A-Z]/.test(value[6] || '') ? baseYear + 30 : baseYear;
}

function platformFromVin(vin) {
  const value = String(vin || '').toUpperCase();
  const year = vinModelYearFromCode(value);
  const wmi = value.slice(0, 3);
  const vds = value.slice(3, 5);
  if ((wmi === '1N4' || wmi === 'JN1') && (vds === 'AA' || vds === 'BA')) {
    let platform = 'A34';
    if (year >= 2016) platform = 'A36';
    else if (year >= 2009) platform = 'A35';
    return {
      platform,
      make: 'Nissan',
      model: 'Maxima',
      year,
      ignitionType: year >= 2016 ? 'push_button' : 'mechanical',
    };
  }
  if (['1N4', 'JN1', '3N1', '5N1'].includes(wmi)) return { platform: 'nissan', make: 'Nissan', model: '', year };
  if (!['1C6', '3C6', '1D7', '1B3', '2C3'].includes(wmi)) return { platform: 'unknown', make: '', model: '', year };
  const platformMap = { R: 'DT', H: 'DJ', C: 'LD', J: 'JC', U: 'DS' };
  const make = wmi.startsWith('1C6') || wmi.startsWith('3C6') ? 'Ram' : 'Dodge';
  return { platform: platformMap[value[3]] || 'unknown', make, model: '', year };
}

function procedureLabel(key) {
  return ({
    add_key: 'Add spare key',
    all_keys_lost: 'All keys lost',
    program_remote: 'Program remote',
    erase_keys: 'Erase / relearn keys',
    module_flash: 'Flash / reprogram module',
    module_coding: 'Module coding',
    bidirectional_control: 'Bidirectional control',
  })[key] || key;
}

function supportedLabel(value) {
  return ({
    true: 'Available',
    false: 'Not supported',
    requires_authorization: 'Requires authorization',
    partial: 'Partial support',
    requires_dealer: 'Dealer only',
  })[value] || value;
}

function evaluateCoverage(record, vehicle) {
  if (!record) {
    return {
      eligible: false,
      blockers: ['No coverage record found for this platform and year.'],
      warnings: ['Key programming procedures cannot be evaluated without a matching coverage entry.'],
      procedures: [],
    };
  }
  const procedures = Object.entries(record.procedures || {}).map(([key, proc]) => ({
    key,
    label: procedureLabel(key),
    supported: proc.supported,
    authorizationRequired: proc.authorizationRequired,
    status: proc.supported
      ? (proc.authorizationRequired ? 'requires_authorization' : 'available')
      : 'not_supported',
  }));
  return {
    eligible: record.supported !== 'false' && record.supported !== false,
    blockers: record.supported === false || record.supported === 'false'
      ? ['This vehicle platform is not supported for key programming.']
      : [],
    warnings: record.warnings || [],
    preconditions: record.preconditions || [],
    procedures,
    record,
  };
}

async function fetchCoverageBundle() {
  const cached = loadOemDiagState().coverageBundle;
  try {
    const params = new URLSearchParams();
    const bundle = await apiFetch(`/diagnostics/coverage/bundle?${params}`);
    saveOemDiagState({ coverageBundle: bundle });
    return bundle;
  } catch {
    if (cached) return cached;
    const response = await fetch('./diagnostics/coverage/seed/dodge-ram-coverage.json');
    if (!response.ok) throw new Error('Coverage data unavailable');
    const bundle = await response.json();
    saveOemDiagState({ coverageBundle: bundle });
    return bundle;
  }
}

function matchCoverage(bundle, vehicle) {
  const records = bundle?.records || [];
  const year = Number(vehicle.modelYear || vehicle.year || 0);
  const platform = vehicle.platform || 'unknown';
  return records.find((record) => {
    const [start, end] = record.yearRange || [0, 9999];
    return record.platform === platform && year >= start && year <= end;
  }) || records.find((record) => record.platform === platform);
}

function normalizeOemAdapter(adapter) {
  if (!adapter) return null;
  return {
    id: adapter.id ?? adapter.Id ?? '',
    name: adapter.name ?? adapter.Name ?? 'Unknown adapter',
    vendor: adapter.vendor ?? adapter.Vendor ?? '',
    dllPath: adapter.dllPath ?? adapter.DllPath ?? '',
    protocols: adapter.protocols ?? adapter.Protocols ?? [],
    firmware: adapter.firmware ?? adapter.Firmware ?? '',
    bitness: adapter.bitness ?? adapter.Bitness ?? '',
    usable: adapter.usable ?? adapter.Usable ?? true,
    usabilityNote: adapter.usabilityNote ?? adapter.UsabilityNote ?? '',
  };
}

function formatCommEntry(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const dir = entry.direction === 'tx' ? 'TX' : 'RX';
  return `[${time}] ${dir} ${entry.address} ${entry.data} — ${entry.description}`;
}

function friendlyOemError(error) {
  const message = String(error?.message || error || 'Diagnostic operation failed');
  if (/capability public key is not configured/i.test(message)) {
    return `${message} Reinstall ShopCrank Desktop from Downloads so the diagnostics verification key is restored.`;
  }
  if (/did not become ready|host script not found|J2534 RPC timeout/i.test(message)) {
    return `${message} Confirm J2534.Host.exe is present, vendor drivers are installed, and antivirus is not blocking the diagnostic host.`;
  }
  return message;
}

const KEY_PROCEDURES = ['add_key', 'all_keys_lost', 'program_remote', 'erase_keys'];
const BIDIRECTIONAL_CONTROLS = [
  ['cooling_fan', 'Cooling fan'],
  ['fuel_pump', 'Fuel pump'],
  ['ac_clutch', 'A/C clutch'],
  ['evap_purge', 'EVAP purge'],
  ['return_control', 'Return control to ECU'],
];

function oemSecurityLoginCard(diag) {
  const auth = diag.autoAuth || {};
  if (auth.connected) {
    const since = auth.connectedAt ? ` · since ${new Date(auth.connectedAt).toLocaleDateString()}` : '';
    return `<section class="oem-panel oem-panel-wide oem-security-login">
        <h3>${icon('shield-check', 16)} Vehicle security access (this shop's login)</h3>
        <div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>Connected</strong><span>${escapeHtml(auth.provider || 'AutoAuth')} · ${escapeHtml(auth.accountId || '')}${escapeHtml(since)}</span></div></div>
        <div class="ledger-note">${icon('info', 15)} Live immobilizer, key programming, and module flashing are unlocked for this shop using your account.</div>
        <div class="ops-actions"><button class="secondary danger" id="oem-autoauth-disconnect">${icon('log-out', 14)} Disconnect account</button></div>
      </section>`;
  }
  return `<section class="oem-panel oem-panel-wide oem-security-login">
      <h3>${icon('shield-check', 16)} Vehicle security access (this shop's login)</h3>
      <div class="messaging-status idle">${icon('lock', 17)}<div><strong>Not connected</strong><span>Sign in with your shop's vehicle security (AutoAuth) account to enable live programming.</span></div></div>
      <form id="oem-autoauth-form" class="form-grid">
        <label>Provider<select name="provider"><option value="autoauth_stellantis">Stellantis AutoAuth</option><option value="autoauth_nissan">Nissan / Infiniti AutoAuth</option><option value="autoauth_generic">Other AutoAuth</option></select></label>
        <label>Account ID / username<input name="accountId" autocomplete="off" required /></label>
        <label>API key / password<input name="apiKey" type="password" autocomplete="off" required /></label>
        <button class="primary" type="submit">${icon('log-in', 14)} Connect account</button>
      </form>`;
}

function oemProgrammingPanel(diag, coverage, vehicle, status) {
  const mode = diag.programmingMode === 'live' ? 'live' : 'simulate';
  const security = diag.security || {};
  const keyProcs = (coverage?.procedures || []).filter((p) => KEY_PROCEDURES.includes(p.key) && p.supported);
  const ecus = vehicle?.ecus || [];
  const targetOptions = (ecus.length ? ecus : [{ logicalAddress: '0x7E1', name: 'ECM' }])
    .map((e) => `<option value="${escapeHtml(e.logicalAddress || '0x7E1')}">${escapeHtml(e.name || e.logicalAddress)}</option>`).join('');
  const progress = Number(diag.flashProgress || 0);
  const result = diag.programmingResult;
  return `<section class="oem-panel oem-panel-wide oem-programming">
      <h3>${icon('key-round', 16)} Programming &amp; flashing</h3>
      <div class="oem-mode-toggle accounting-tabs">
        <button class="tab ${mode === 'simulate' ? 'active' : ''}" data-prog-mode="simulate">Simulate (bench)</button>
        <button class="tab ${mode === 'live' ? 'active' : ''}" data-prog-mode="live">Live (AutoAuth)</button>
      </div>
      <div class="ledger-note">${icon('shield-alert', 15)} ${mode === 'live'
        ? 'LIVE mode drives real vehicle modules. Require a signed repair order, shop AutoAuth credentials, a regulated 12V+ supply, and the correct ignition state before proceeding.'
        : 'SIMULATE mode exercises the bench simulator only — safe for training and verification.'}</div>
      <div class="ops-actions">
        <button class="secondary" id="oem-sec-immo" ${status.connected ? '' : 'disabled'}>${icon('lock-open', 14)} Unlock immobilizer</button>
        <button class="secondary" id="oem-sec-flash" ${status.connected ? '' : 'disabled'}>${icon('lock-open', 14)} Unlock programming</button>
        <span class="muted">${security.scope ? `Security unlocked: ${escapeHtml(security.scope)}` : 'Locked'}</span>
      </div>
      <div class="oem-prog-actions ops-actions">
        ${keyProcs.length
          ? keyProcs.map((p) => `<button class="secondary" data-prog-key="${escapeHtml(p.key)}" ${status.connected ? '' : 'disabled'}>${icon('key', 14)} ${escapeHtml(p.label)}</button>`).join('')
          : '<p class="muted">No key procedures published for this platform.</p>'}
      </div>
      <div class="oem-flash">
        <label>Module<select id="oem-flash-target">${targetOptions}</select></label>
        <label>Firmware<input type="file" id="oem-flash-file" accept=".bin,.cal,.flash,.s19,.hex,.frf" /></label>
        <button class="primary danger" id="oem-flash-run" ${status.connected ? '' : 'disabled'}>${icon('cpu', 14)} Flash module</button>
        ${progress > 0 ? `<div class="oem-progress"><div class="oem-progress-bar" style="width:${progress}%"></div><span>${progress}%</span></div>` : ''}
      </div>
      <div class="oem-coding">
        <h4>Module coding</h4>
        <label>Identifier (DID)<input id="oem-code-did" placeholder="F190" maxlength="6" /></label>
        <label>Data (hex)<input id="oem-code-data" placeholder="01 02" /></label>
        <button class="secondary" id="oem-code-run" ${status.connected ? '' : 'disabled'}>${icon('pencil', 14)} Write coding</button>
      </div>
      <div class="oem-bidirectional">
        <h4>Bidirectional controls</h4>
        <div class="ops-actions">
          ${BIDIRECTIONAL_CONTROLS.map(([id, label]) => `<button class="secondary" data-bidi="${id}" ${status.connected ? '' : 'disabled'}>${icon('activity', 14)} ${escapeHtml(label)}</button>`).join('')}
        </div>
      </div>
      ${result ? `<div class="messaging-status ready">${icon('circle-check', 15)}<div><strong>${escapeHtml(result.title)}</strong><span>${escapeHtml(result.detail)}</span></div></div>` : ''}
    </section>`;
}

function oemDiagnosticsView() {
  const diag = loadOemDiagState();
  const status = diag.connectionStatus || {};
  const vehicle = diag.vehicleIdentification;
  const coverage = diag.coverageEvaluation;
  const log = (diag.commLog || []).slice(-100).map(formatCommEntry).join('\n') || 'No communication yet.';
  const dtcs = (diag.dtcs || []).map((d) => `${d.code} (${d.status}) — ${d.description}`).join('\n') || 'No DTCs read yet.';

  const desktop = isOemDiagnosticsAvailable();

  const adaptersList = (diag.adapters || []).map(normalizeOemAdapter).filter(Boolean);
  const hardwareAdapters = adaptersList.filter((a) => a.id !== 'simulator');
  const adapters = adaptersList.map((a) => `<option value="${escapeHtml(a.id)}" ${diag.selectedAdapter === a.id ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.vendor)})</option>`).join('');
  const adapterHelp = hardwareAdapters.length
    ? ''
    : `<div class="ledger-note">${icon('info', 15)} No J2534 hardware detected. Install your adapter vendor software (for TOPDON RLink X7: RLink Platform → Drivers → download the J2534 driver), plug in USB, then click Refresh. ShopCrank scans both 64-bit and 32-bit Windows J2534 registry entries.</div>`;

  const desktopNote = desktop
    ? ''
    : `<div class="ledger-note">${icon('monitor', 15)} The vehicle bus runs in the ShopCrank Windows app with a J2534 pass-thru. Connect the shop AutoAuth account here, then open OEM diagnostics on that PC and choose Live.</div>`;
  return shell(`${heading('OEM diagnostics', 'Dodge / Ram / Nissan diagnostics', 'Live OEM programming, module coding, and key registration on Shop Pro with AutoAuth and a J2534 pass-thru.', false)}
    ${desktopNote}
    <section class="oem-phase-notice">${icon('shield-alert', 16)}<span><strong>Authorized shop use only.</strong> Diagnostics and any programming-class work require a signed repair order, a licensed J2534 interface, and shop AutoAuth credentials for live mode. ShopCrank does not provide immobilizer bypass, key cloning, rolling-code attacks, or theft-unlock tools.</span></section>
    <section class="diagnostics-console oem-diagnostics">
      <div class="oem-preflight">
        <h3>Pre-flight checklist</h3>
        <ul class="ai-checklist">
          <li>${icon('check-circle-2', 13)}Use a regulated 12V+ power supply when programming-class work is planned</li>
          <li>${icon('check-circle-2', 13)}Ignition ON — verify correct ignition state for the procedure</li>
          <li>${icon('check-circle-2', 13)}PC sleep is blocked automatically during an active session</li>
          <li>${icon('check-circle-2', 13)}Do not disconnect the USB J2534 adapter during a session</li>
          <li>${icon('check-circle-2', 13)}Confirm VIN matches the work order before any security operation</li>
        </ul>
      </div>
      <div class="oem-grid">
        <section class="oem-panel">
          <h3>${icon('usb', 16)} J2534 adapter</h3>
          <div class="messaging-status ${status.connected ? 'ready' : 'idle'}">${icon(status.connected ? 'circle-check' : 'plug-zap', 17)}<div><strong>${status.connected ? 'Connected' : 'Not connected'}</strong><span>${status.connected ? `${escapeHtml(status.protocol || '')} · ${status.voltage ?? '—'} V` : 'Select adapter and connect'}</span></div></div>
          <label>Adapter<select id="oem-adapter-select">${adapters || '<option value="simulator">ShopCrank CAN Simulator</option>'}</select></label>
          ${adapterHelp}
          <div class="ops-actions">
            <button class="primary" id="oem-refresh-adapters">${icon('refresh-cw', 14)} Refresh</button>
            <button class="primary" id="oem-connect" ${status.connected ? 'disabled' : ''}>${icon('plug-zap', 14)} Connect</button>
            <button class="secondary" id="oem-disconnect" ${status.connected ? '' : 'disabled'}>${icon('unplug', 14)} Disconnect</button>
          </div>
        </section>
        <section class="oem-panel">
          <h3>${icon('fingerprint', 16)} Vehicle identification</h3>
          ${vehicle ? `<dl class="oem-ident"><dt>VIN</dt><dd class="mono">${escapeHtml(vehicle.vin)}</dd><dt>Make / year</dt><dd>${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model || '')} ${vehicle.modelYear}</dd><dt>Platform</dt><dd>${escapeHtml(vehicle.platform)}</dd><dt>Ignition</dt><dd>${escapeHtml(vehicle.ignitionType)}</dd></dl>` : '<p class="muted">Connect and identify vehicle to read VIN and ECU data.</p>'}
          <div class="ops-actions">
            <button class="primary" id="oem-identify" ${status.connected ? '' : 'disabled'}>${icon('scan', 14)} Identify vehicle</button>
          </div>
          ${vehicle?.ecus?.length ? `<table class="mini-table"><thead><tr><th>ECU</th><th>Part #</th><th>Software</th></tr></thead><tbody>${vehicle.ecus.map((ecu) => `<tr><td>${escapeHtml(ecu.name || ecu.logicalAddress)}</td><td class="mono">${escapeHtml(ecu.partNumber)}</td><td>${escapeHtml(ecu.softwareVersion)}</td></tr>`).join('')}</tbody></table>` : ''}
        </section>
        <section class="oem-panel">
          <h3>${icon('key-round', 16)} Coverage &amp; eligibility</h3>
          ${coverage ? `<p><strong>${supportedLabel(coverage.record?.supported)}</strong> — ${escapeHtml(coverage.record?.make || '')} ${escapeHtml(coverage.record?.model || '')} (${escapeHtml(coverage.record?.platform || '')})</p>
            <ul class="ai-checklist">${coverage.procedures.map((p) => `<li>${icon(p.status === 'not_supported' ? 'circle-x' : 'shield-check', 13)}${escapeHtml(p.label)}: ${p.supported ? (p.authorizationRequired ? 'requires authorization' : 'available') : 'not supported'}</li>`).join('')}</ul>
            ${coverage.warnings?.length ? `<div class="oem-warnings">${coverage.warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join('')}</div>` : ''}` : '<p class="muted">Identify vehicle to evaluate key-programming procedure availability.</p>'}
        </section>
        <section class="oem-panel">
          <h3>${icon('triangle-alert', 16)} Diagnostic trouble codes</h3>
          <pre class="diagnostics-output">${escapeHtml(dtcs)}</pre>
          <div class="ops-actions">
            <button class="secondary" id="oem-read-dtcs" ${status.connected ? '' : 'disabled'}>${icon('scan-line', 14)} Read DTCs</button>
            <button class="secondary danger" id="oem-clear-dtcs" ${status.connected ? '' : 'disabled'}>${icon('eraser', 14)} Clear DTCs</button>
          </div>
        </section>
        ${oemSecurityLoginCard(diag)}
        ${oemProgrammingPanel(diag, coverage, vehicle, status)}
        <section class="oem-panel oem-panel-wide">
          <h3>${icon('radio', 16)} Communication log</h3>
          <div class="ops-actions">
            <button class="secondary" id="oem-start-log" ${status.connected ? '' : 'disabled'}>${icon('activity', 14)} Start live log</button>
            <button class="secondary" id="oem-stop-log">${icon('square', 14)} Stop log</button>
            <button class="secondary" id="oem-export-log">${icon('download', 14)} Export</button>
          </div>
          <pre class="diagnostics-output oem-comm-log" id="oem-comm-log">${escapeHtml(log)}</pre>
        </section>
      </div>
      ${diag.lastError ? `<div class="login-error oem-error">${icon('alert-circle', 14)} ${escapeHtml(diag.lastError)}<p class="muted">Preserve the adapter connection. Do not repeat programming commands after a failure. Review the communication log and recovery steps in manufacturer service information.</p></div>` : ''}
    </section>`);
}

async function refreshOemAdapters() {
  const api = oemDiagApi();
  const result = await api.listAdapters();
  const adapters = (result.adapters || []).map(normalizeOemAdapter).filter(Boolean);
  const hardware = adapters.filter((a) => a.id !== 'simulator');
  saveOemDiagState({
    adapters,
    selectedAdapter: hardware[0]?.id || adapters[0]?.id || 'simulator',
    lastError: null,
  });
}

async function refreshOemConnectionStatus() {
  const api = oemDiagApi();
  const status = await api.getConnectionStatus();
  saveOemDiagState({ connectionStatus: status, lastError: null });
  return status;
}

async function oemConnect() {
  const diag = loadOemDiagState();
  const select = document.querySelector('#oem-adapter-select');
  const adapterId = select?.value || diag.selectedAdapter || 'simulator';
  saveOemDiagState({ selectedAdapter: adapterId, lastError: null });
  await oemDiagApi().connect({ adapterId, protocol: 'ISO15765' });
  await refreshOemConnectionStatus();
  toast('J2534 adapter connected');
}

async function oemDisconnect() {
  await oemDiagApi().disconnect();
  await oemDiagApi().stopLiveLog().catch(() => {});
  if (window._oemLogTimer) clearInterval(window._oemLogTimer);
  saveOemDiagState({ connectionStatus: { connected: false }, lastError: null });
  toast('J2534 adapter disconnected');
}

async function oemIdentifyVehicle() {
  const api = oemDiagApi();
  const vehicle = await api.identifyVehicle();
  const decoded = platformFromVin(vehicle.vin);
  vehicle.make = vehicle.make || decoded.make;
  vehicle.model = vehicle.model || decoded.model || '';
  vehicle.modelYear = vehicle.modelYear || decoded.year;
  vehicle.platform = !vehicle.platform || vehicle.platform === 'unknown' ? decoded.platform : vehicle.platform;
  if (decoded.ignitionType) vehicle.ignitionType = vehicle.ignitionType || decoded.ignitionType;
  let nhtsa = null;
  try {
    nhtsa = await apiFetch(`/vehicles/decode/${encodeURIComponent(vehicle.vin)}`);
    if (nhtsa?.make) vehicle.make = nhtsa.make;
    if (nhtsa?.model) vehicle.model = nhtsa.model;
    if (nhtsa?.year) vehicle.modelYear = Number(nhtsa.year) || vehicle.modelYear;
  } catch { /* offline or unauthenticated — use on-vehicle data */ }
  const bundle = await fetchCoverageBundle();
  const coverageEvaluation = evaluateCoverage(matchCoverage(bundle, vehicle), vehicle);
  saveOemDiagState({ vehicleIdentification: vehicle, coverageEvaluation, lastError: null });
  toast(`Vehicle identified: ${vehicle.vin}`);
}

async function oemReadDtcs() {
  const result = await oemDiagApi().readDtcs();
  saveOemDiagState({ dtcs: result.dtcs || [], lastError: null });
  toast('DTCs read');
}

async function oemClearDtcs() {
  if (!confirm('Clear stored diagnostic trouble codes? This may reset readiness monitors and should only be done after repairs are verified.')) return;
  const vin = loadOemDiagState().vehicleIdentification?.vin || 'UNKNOWNVIN0000000';
  const auth = await apiFetch('/diagnostics/authorize', {
    method: 'POST',
    body: JSON.stringify({ vin, procedure: 'clear_dtcs' }),
  });
  if (!auth?.authorized || !auth.token) throw new Error(auth?.message || 'Clear DTC authorization denied');
  await oemDiagApi().clearDtcs({ authorizationToken: auth.token });
  saveOemDiagState({ dtcs: [], lastError: null });
  toast('DTCs cleared');
}

async function oemPollLog() {
  const diag = loadOemDiagState();
  const since = diag.lastLogTimestamp || 0;
  const result = await oemDiagApi().pollLiveLog(since);
  const entries = result.entries || [];
  if (!entries.length) return;
  const merged = (diag.commLog || []).concat(entries).slice(-500);
  saveOemDiagState({
    commLog: merged,
    lastLogTimestamp: entries[entries.length - 1].timestamp,
  });
}

async function oemLoadAutoAuth() {
  try {
    const auth = await apiFetch('/diagnostics/autoauth');
    saveOemDiagState({ autoAuth: auth });
    return auth;
  } catch {
    return null; // offline / unauthenticated — treat as not connected
  }
}

async function oemConnectAutoAuth(form) {
  const data = Object.fromEntries(new FormData(form));
  const auth = await apiFetch('/diagnostics/autoauth', {
    method: 'POST',
    body: JSON.stringify({ provider: data.provider, accountId: data.accountId, apiKey: data.apiKey }),
  });
  saveOemDiagState({
    autoAuth: { connected: true, provider: auth.provider, accountId: auth.accountId, connectedAt: auth.connectedAt },
    lastError: null,
  });
  toast('Vehicle security account connected');
}

async function oemDisconnectAutoAuth() {
  await apiFetch('/diagnostics/autoauth', { method: 'DELETE' });
  saveOemDiagState({ autoAuth: { connected: false }, programmingMode: 'simulate' });
  toast('Vehicle security account disconnected');
}

async function oemAuthorize(procedure) {
  const diag = loadOemDiagState();
  const vin = diag.vehicleIdentification?.vin;
  if (!vin) throw new Error('Identify the vehicle before authorizing a procedure');
  const mode = diag.programmingMode === 'live' ? 'live' : 'simulate';
  const auth = await apiFetch('/diagnostics/authorize', {
    method: 'POST',
    body: JSON.stringify({ vin, procedure, mode }),
  });
  if (!auth?.authorized || !auth.token) throw new Error(auth?.message || 'Authorization denied');
  return { token: auth.token, mode, vin };
}

async function oemAudit(event) {
  try { await apiFetch('/diagnostics/audit', { method: 'POST', body: JSON.stringify(event) }); } catch { /* audit is best-effort */ }
}

async function oemUnlockSecurity(scope, authorizationToken) {
  const result = await oemDiagApi().securityAccess({ scope, ...(authorizationToken ? { authorizationToken } : {}) });
  saveOemDiagState({ security: { scope: result.scope, at: Date.now() }, lastError: null });
  toast(`SecurityAccess granted: ${result.scope}`);
}

async function oemProgram(procedure) {
  const diag = loadOemDiagState();
  const mode = diag.programmingMode === 'live' ? 'live' : 'simulate';
  if (!confirm(`${procedureLabel(procedure)} (${mode} mode)? Confirm the VIN and vehicle state before continuing.`)) return;
  const { token, vin } = await oemAuthorize(procedure);
  // Immobilizer procedures require SecurityAccess before RoutineControl.
  if (!diag.security?.scope || diag.security.scope !== 'immobilizer' || mode === 'live') {
    await oemUnlockSecurity('immobilizer', token);
  }
  const result = await oemDiagApi().programKey({ procedure, authorizationToken: token });
  await oemAudit({ kind: 'diagnostics.program', procedure, vin, mode, keys: result.keys, remotes: result.remotes });
  saveOemDiagState({
    programmingResult: { title: `${procedureLabel(procedure)} complete`, detail: `${result.keys ?? 0} key(s), ${result.remotes ?? 0} remote(s) programmed` },
    lastError: null,
  });
  toast('Programming procedure complete');
}

async function oemCodeModule() {
  const target = document.querySelector('#oem-flash-target')?.value || '0x7E0';
  const did = document.querySelector('#oem-code-did')?.value || '';
  const data = document.querySelector('#oem-code-data')?.value || '';
  const mode = loadOemDiagState().programmingMode === 'live' ? 'live' : 'simulate';
  if (!confirm(`Write coding ${did} on ${target} (${mode} mode)? Confirm the VIN before continuing.`)) return;
  const { token, vin } = await oemAuthorize('module_coding');
  if (loadOemDiagState().security?.scope !== 'flash' || mode === 'live') await oemUnlockSecurity('flash', token);
  const result = await oemDiagApi().codeModule({ target, did, data, authorizationToken: token });
  await oemAudit({ kind: 'diagnostics.coding', target, did, vin, mode, bytes: result.bytes });
  saveOemDiagState({
    programmingResult: { title: 'Module coding complete', detail: `${target} · DID ${result.did} · ${result.bytes} bytes` },
    lastError: null,
  });
  toast('Module coding complete');
}

async function oemBidirectional(control) {
  const label = BIDIRECTIONAL_CONTROLS.find(([id]) => id === control)?.[1] || control;
  const mode = loadOemDiagState().programmingMode === 'live' ? 'live' : 'simulate';
  if (!confirm(`${label} (${mode} mode)? Stay with the vehicle until control returns to the module.`)) return;
  const { token, vin } = await oemAuthorize('bidirectional_control');
  const result = await oemDiagApi().bidirectionalControl({ control, authorizationToken: token });
  await oemAudit({ kind: 'diagnostics.bidirectional', control, vin, mode, state: result.state });
  saveOemDiagState({
    programmingResult: { title: `${label} ${result.state}`, detail: `${control} · ${mode}` },
    lastError: null,
  });
  toast(`${label} ${result.state}`);
}

async function oemFlashModule() {
  const diag = loadOemDiagState();
  const mode = diag.programmingMode === 'live' ? 'live' : 'simulate';
  const target = document.querySelector('#oem-flash-target')?.value || '0x7E1';
  const file = document.querySelector('#oem-flash-file')?.files?.[0];
  if (!file) throw new Error('Select a firmware file to flash');
  if (!confirm(`Flash ${target} with ${file.name} (${mode} mode)? Do not disconnect the adapter or interrupt power.`)) return;
  const size = file.size;
  const { token, vin } = await oemAuthorize('module_flash');
  if (diag.security?.scope !== 'flash' || mode === 'live') await oemUnlockSecurity('flash', token);
  saveOemDiagState({ flashProgress: 5 });
  render();
  const result = await oemDiagApi().flashModule({
    target,
    authorizationToken: token,
    firmware: { size, version: file.name },
  });
  await oemAudit({ kind: 'diagnostics.flash', target, vin, mode, bytes: size, blocks: result.blocks });
  saveOemDiagState({
    flashProgress: 100,
    programmingResult: { title: 'Module flash complete', detail: `${target} · ${size} bytes · ${result.blocks} blocks · ${result.softwareVersion}` },
    lastError: null,
  });
  toast('Module flash complete');
}

function bindOemDiagnostics() {
  document.querySelector('#oem-autoauth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await oemConnectAutoAuth(event.target); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-autoauth-disconnect')?.addEventListener('click', async () => {
    try { await oemDisconnectAutoAuth(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  if (loadOemDiagState().autoAuth === undefined) {
    oemLoadAutoAuth().then((auth) => { if (auth && state.route === 'oem-diagnostics') render(); });
  }
  document.querySelectorAll('[data-prog-mode]').forEach((button) => button.addEventListener('click', () => {
    saveOemDiagState({ programmingMode: button.dataset.progMode, programmingResult: null, flashProgress: 0 });
    render();
  }));
  if (!isOemDiagnosticsAvailable()) return;
  // Live unlocks belong to an authorized job, so the standalone buttons only drive the bench simulator.
  const standaloneUnlock = scope => async () => {
    if (loadOemDiagState().programmingMode === 'live') {
      saveOemDiagState({ lastError: 'In Live mode SecurityAccess runs automatically when you start an authorized key, flash, or coding job.' });
      render();
      return;
    }
    try { await oemUnlockSecurity(scope); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  };
  document.querySelector('#oem-sec-immo')?.addEventListener('click', standaloneUnlock('immobilizer'));
  document.querySelector('#oem-sec-flash')?.addEventListener('click', standaloneUnlock('flash'));
  document.querySelectorAll('[data-prog-key]').forEach((button) => button.addEventListener('click', async () => {
    try { await oemProgram(button.dataset.progKey); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  }));
  document.querySelector('#oem-code-run')?.addEventListener('click', async () => {
    try { await oemCodeModule(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelectorAll('[data-bidi]').forEach((button) => button.addEventListener('click', async () => {
    try { await oemBidirectional(button.dataset.bidi); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  }));
  document.querySelector('#oem-flash-run')?.addEventListener('click', async () => {
    try { await oemFlashModule(); render(); } catch (e) { saveOemDiagState({ flashProgress: 0, lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-refresh-adapters')?.addEventListener('click', async () => {
    try { await refreshOemAdapters(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-connect')?.addEventListener('click', async () => {
    try { await oemConnect(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-disconnect')?.addEventListener('click', async () => {
    try { await oemDisconnect(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-identify')?.addEventListener('click', async () => {
    try { await oemIdentifyVehicle(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-read-dtcs')?.addEventListener('click', async () => {
    try { await oemReadDtcs(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-clear-dtcs')?.addEventListener('click', async () => {
    try { await oemClearDtcs(); render(); } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-start-log')?.addEventListener('click', async () => {
    try {
      await oemDiagApi().startLiveLog();
      if (window._oemLogTimer) clearInterval(window._oemLogTimer);
      window._oemLogTimer = setInterval(async () => {
        if (state.route !== 'oem-diagnostics') return;
        try { await oemPollLog(); const el = document.querySelector('#oem-comm-log'); if (el) el.textContent = (loadOemDiagState().commLog || []).slice(-100).map(formatCommEntry).join('\n'); } catch { /* ignore poll errors */ }
      }, 1500);
      toast('Live communication log started');
    } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-stop-log')?.addEventListener('click', async () => {
    try {
      await oemDiagApi().stopLiveLog();
      if (window._oemLogTimer) clearInterval(window._oemLogTimer);
      toast('Live log stopped');
    } catch (e) { saveOemDiagState({ lastError: friendlyOemError(e) }); render(); }
  });
  document.querySelector('#oem-export-log')?.addEventListener('click', () => {
    const log = (loadOemDiagState().commLog || []).map(formatCommEntry).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([log], { type: 'text/plain' }));
    link.download = `shopcrank-comm-log-${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Communication log exported');
  });
  document.querySelector('#oem-adapter-select')?.addEventListener('change', (e) => {
    saveOemDiagState({ selectedAdapter: e.target.value });
  });
  if (!loadOemDiagState().adapters?.length) {
    refreshOemAdapters().then(() => { if (state.route === 'oem-diagnostics') render(); }).catch(() => {});
  }
}

/* rebuild 20260911175056 */
