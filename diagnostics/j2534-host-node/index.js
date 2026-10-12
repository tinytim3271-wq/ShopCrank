/**
 * MechPro J2534 diagnostic host — Node.js implementation with simulator mode.
 * On Windows with a real J2534 DLL, the C# J2534.Host.exe is preferred.
 * This host provides the same JSON-RPC named-pipe protocol for development and CI.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PIPE_NAME = process.env.MECHPRO_J2534_PIPE || (process.platform === 'win32'
  ? '\\\\.\\pipe\\mechpro-j2534'
  : path.join(os.tmpdir(), 'mechpro-j2534.sock'));
const HOST_TOKEN = process.env.MECHPRO_J2534_TOKEN || '';

const SIM_VIN = '1C6SRFHT0LN123456';
const SIM_PLATFORM = 'DT';

/** @type {import('./simulator').SimulatorState} */
let sim = null;

function createSimulator() {
  const { createSimulatorState } = require('./simulator');
  return createSimulatorState();
}

function logEntry(direction, address, data, description) {
  if (!sim) return;
  sim.commLog.push({
    timestamp: Date.now(),
    direction,
    address,
    data: Buffer.isBuffer(data) ? data.toString('hex').toUpperCase() : String(data),
    description,
  });
  if (sim.commLog.length > 5000) sim.commLog.shift();
}

function assertAuth(params = {}) {
  // Fail closed unless explicitly opted into unauthenticated local/dev hosts.
  if (!HOST_TOKEN) {
    if (process.env.MECHPRO_ALLOW_UNAUTHENTICATED_HOST === '1') return;
    throw new Error('Unauthorized J2534 RPC — host token not configured');
  }
  if (String(params.authToken || '') !== HOST_TOKEN) {
    throw new Error('Unauthorized J2534 RPC — invalid host token');
  }
}

function handleRequest(req) {
  const { id, method, params = {} } = req;
  try {
    assertAuth(params);
    const result = dispatch(method, params);
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: error.message } };
  }
}

function dispatch(method, params) {
  switch (method) {
    case 'ping':
      return { ok: true, simulator: sim?.simulator ?? true };
    case 'listAdapters':
      return listAdapters();
    case 'connect':
      return connect(params);
    case 'disconnect':
      return disconnect();
    case 'getConnectionStatus':
      return getConnectionStatus();
    case 'readVin':
      return readVin();
    case 'identifyEcus':
      return identifyEcus();
    case 'readDtcs':
      return readDtcs();
    case 'clearDtcs':
      return clearDtcs(params);
    case 'securityAccess':
      return securityAccess(params);
    case 'programKey':
    case 'addKey':
      return programKey('add_key', params);
    case 'allKeysLost':
      return programKey('all_keys_lost', params);
    case 'programRemote':
      return programKey('program_remote', params);
    case 'eraseKeys':
      return programKey('erase_keys', params);
    case 'flashModule':
      return flashModule(params);
    case 'codeModule':
      return codeModule(params);
    case 'bidirectionalControl':
      return bidirectionalControl(params);
    case 'startLiveLog':
      if (!sim?.connected) throw new Error('Not connected to vehicle bus');
      sim.liveLogActive = true;
      return { active: true };
    case 'stopLiveLog':
      if (sim) sim.liveLogActive = false;
      return { active: false };
    case 'pollLiveLog':
      return pollLiveLog(params.since);
    case 'identifyVehicle':
      return identifyVehicle();
    case 'obdSnapshot':
      return obdSnapshot();
    case 'obdClearDtcs':
      return obdClearDtcs(params);
    case 'keyProcedureSupport':
      return keyProcedureSupport(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

const KEY_PROCEDURES = ['add_key', 'all_keys_lost', 'program_remote', 'erase_keys'];

/** Generic OBD-II snapshot from the bench simulator (same shape as the .NET host). */
function obdSnapshot() {
  requireConnection();
  logEntry('tx', '0x7E0', '0902', 'OBD mode 09 VIN (simulator)');
  const stored = (sim.dtcs || []).map((dtc) => dtc.code);
  return {
    source: 'simulator',
    simulator: true,
    adapterName: 'MechPro CAN Simulator',
    protocol: 'ISO 15765-4 CAN 11-bit 500 kbps (engine ECU 0x7E0)',
    responded: true,
    vin: SIM_VIN,
    milOn: stored.length > 0,
    reportedDtcCount: stored.length,
    supportedPids: ['0x01', '0x05', '0x0C', '0x42'],
    readings: [
      { pid: '0x05', name: 'Coolant temperature', value: 90, unit: 'C', raw: '82' },
      { pid: '0x0C', name: 'Engine speed', value: 780, unit: 'rpm', raw: '0C30' },
      { pid: '0x42', name: 'Control module voltage', value: 14, unit: 'V', raw: '36B0' },
    ],
    storedDtcs: stored,
    pendingDtcs: [],
    permanentDtcs: [],
    errors: [],
    voltage: sim.voltage,
    readAt: new Date().toISOString(),
  };
}

function obdClearDtcs(params = {}) {
  requireConnection();
  if (params.confirmed !== true) {
    throw new Error('Clearing codes also erases freeze-frame data and readiness monitors. Confirm before clearing.');
  }
  sim.dtcs = [];
  logEntry('tx', '0x7E0', '04', 'OBD mode 04 clear (simulator)');
  logEntry('rx', '0x7E8', '44', 'Codes cleared (simulator)');
  return { cleared: true, simulator: true, clearedAt: new Date().toISOString() };
}

function keyProcedureSupport(params = {}) {
  requireConnection();
  const procedure = String(params.procedure || '').trim();
  if (!KEY_PROCEDURES.includes(procedure)) {
    return { supported: false, simulator: true, procedure, vin: SIM_VIN, requiresVehiclePin: false, reason: `Unknown key procedure '${procedure}'.` };
  }
  return { supported: true, simulator: true, procedure, vin: SIM_VIN, requiresVehiclePin: false, reason: 'Bench simulator. Nothing is written to a vehicle.' };
}

function listAdapters() {
  const adapters = [];
  const seenDlls = new Set();
  if (process.platform === 'win32') {
    const roots = [
      'HKLM\\SOFTWARE\\PassThruSupport.04.04',
      'HKLM\\SOFTWARE\\WOW6432Node\\PassThruSupport.04.04',
      'HKLM\\SOFTWARE\\PassThruSupport.04.02',
      'HKLM\\SOFTWARE\\WOW6432Node\\PassThruSupport.04.02',
    ];
    for (const root of roots) {
      for (const entry of readWindowsRegistryAdapters(root)) {
        const key = entry.dllPath.toLowerCase();
        if (seenDlls.has(key)) continue;
        seenDlls.add(key);
        adapters.push(entry);
      }
    }
    for (const root of ['HKLM\\SOFTWARE\\PassThruSupport.04.04', 'HKLM\\SOFTWARE\\PassThruSupport.04.02']) {
      for (const entry of readWindowsRegistryAdapters(root, 32)) {
        const key = entry.dllPath.toLowerCase();
        if (seenDlls.has(key)) continue;
        seenDlls.add(key);
        adapters.push(entry);
      }
    }
  }
  adapters.push({
    id: 'simulator',
    name: 'MechPro CAN Simulator (Dodge/Ram bench)',
    vendor: 'MechPro',
    dllPath: 'builtin-simulator',
    protocols: ['CAN', 'ISO15765'],
    firmware: '1.0.0-sim',
  });
  return { adapters, simulator: adapters.length === 1 };
}

function readWindowsRegistryAdapters(root, view = 64) {
  try {
    const { execSync } = require('node:child_process');
    const viewFlag = view === 32 ? ' /reg:32' : '';
    const output = execSync(`reg query "${root}" /s${viewFlag}`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries = [];
    let currentKey = null;
    let currentValues = {};
    for (const line of output.split(/\r?\n/)) {
      const keyMatch = line.match(/^HKEY_LOCAL_MACHINE\\(.+)$/i);
      if (keyMatch) {
        if (currentKey) entries.push({ key: currentKey, values: currentValues });
        currentKey = keyMatch[1];
        currentValues = {};
        continue;
      }
      const valueMatch = line.trim().match(/^(\S+)\s+REG_\S+\s+(.+)$/);
      if (valueMatch && currentKey) currentValues[valueMatch[1]] = valueMatch[2].trim();
    }
    if (currentKey) entries.push({ key: currentKey, values: currentValues });

    const prefix = root.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\');
    return entries
      .filter((entry) => entry.key.startsWith(`${prefix}\\`) && entry.key !== prefix)
      .map((entry) => {
        const subKey = entry.key.slice(prefix.length + 1);
        const dllPath = (entry.values.FunctionLibrary || '').replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
        if (!dllPath) return null;
        const name = entry.values.Name || subKey;
        const vendor = entry.values.Vendor || name.split(/\s+/)[0] || name;
        const scope = root.includes('WOW6432Node') || view === 32 ? 'wow64' : 'native';
        const version = root.includes('04.02') ? '0402' : '0404';
        const slug = subKey.replace(/\s+/g, '-').toLowerCase();
        return {
          id: `registry-${scope}-${version}-${slug}`,
          name,
          vendor,
          dllPath,
          protocols: ['CAN', 'ISO15765', 'ISO15765_FD'],
          firmware: 'unknown',
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function connect(params) {
  if (!sim) sim = createSimulator();
  const adapterId = params.adapterId || 'simulator';
  if (!adapterId) throw new Error('adapterId is required');
  sim.connected = true;
  sim.adapterId = adapterId;
  sim.protocol = params.protocol || 'ISO15765';
  sim.voltage = 12.6 + Math.random() * 0.4;
  sim.commFault = false;
  logEntry('tx', '0x7E0', '1003', 'Diagnostic session start');
  logEntry('rx', '0x7E8', '5003', 'Positive response');
  return { connected: true, protocol: sim.protocol, voltage: Math.round(sim.voltage * 10) / 10 };
}

function disconnect() {
  if (sim) {
    sim.connected = false;
    sim.liveLogActive = false;
  }
  return { connected: false };
}

function getConnectionStatus() {
  if (!sim?.connected) {
    return { connected: false, adapterId: null, protocol: null, voltage: null, commFault: false };
  }
  return {
    connected: true,
    adapterId: sim.adapterId,
    protocol: sim.protocol,
    voltage: Math.round(sim.voltage * 10) / 10,
    commFault: sim.commFault,
  };
}

function requireConnection() {
  if (!sim?.connected) throw new Error('Not connected. Select an adapter and connect first.');
}

function readVin() {
  requireConnection();
  logEntry('tx', '0x7E0', '22F190', 'Read VIN (UDS 0x22 F1 90)');
  logEntry('rx', '0x7E8', `62F190${Buffer.from(SIM_VIN).toString('hex').toUpperCase()}`, 'VIN response');
  return { vin: SIM_VIN, source: 'UDS_22_F190', raw: SIM_VIN };
}

function identifyEcus() {
  requireConnection();
  const ecus = [
    { logicalAddress: '0x7E0', name: 'Gateway (SGW)', partNumber: '68429235AE', softwareVersion: '23.23.1', calibrationId: 'DT_GW_2024' },
    { logicalAddress: '0x7E1', name: 'ECM', partNumber: '05094923AI', softwareVersion: '23.15.0', calibrationId: 'DT_ECM_5.7L' },
    { logicalAddress: '0x7E2', name: 'TCM', partNumber: '05094924AB', softwareVersion: '22.10.3', calibrationId: 'DT_TCM_8HP' },
    { logicalAddress: '0x7E3', name: 'BCM', partNumber: '68429240AC', softwareVersion: '21.08.2', calibrationId: 'DT_BCM' },
  ];
  const securityModules = [
    { type: 'gateway', logicalAddress: '0x7E0', partNumber: '68429235AE', generation: 'SGW_DT' },
    { type: 'rf_hub', logicalAddress: '0x7E4', partNumber: '68394147AA', generation: 'Gen3' },
    { type: 'immobilizer', logicalAddress: '0x7E0', partNumber: '68429235AE', generation: 'integrated' },
  ];
  ecus.forEach((ecu) => {
    logEntry('tx', ecu.logicalAddress, '22F18A', `Read part number from ${ecu.name}`);
    logEntry('rx', ecu.logicalAddress.replace('0x7E', '0x7E8'), `62F18A${Buffer.from(ecu.partNumber).toString('hex').toUpperCase()}`, 'Part number response');
  });
  return {
    ecus,
    securityModules,
    networkTopology: ecus.map((e) => e.logicalAddress).concat(['0x7E4']),
  };
}

function readDtcs() {
  requireConnection();
  logEntry('tx', '0x7E0', '1902FF', 'Read DTCs (UDS 0x19 02 FF)');
  logEntry('rx', '0x7E8', '5902FF0000', 'No DTCs stored');
  return {
    dtcs: sim.dtcs.length ? sim.dtcs : [],
  };
}

function verifyProcedureToken(procedure, params = {}) {
  const { verifyCapabilityToken } = require('./capability-token');
  // The Node host is the bench simulator, so it only accepts SIMULATE-mode
  // tokens. Real hardware programming runs through the .NET host with a
  // LIVE-mode token and licensed AutoAuth credentials.
  return verifyCapabilityToken(params.authorizationToken, { procedure, mode: 'simulate' });
}

function clearDtcs(params = {}) {
  verifyProcedureToken('clear_dtcs', params);
  requireConnection();
  logEntry('tx', '0x7E0', '14FFFFFF', 'Clear DTCs (UDS 0x14 FF FF FF)');
  logEntry('rx', '0x7E8', '54', 'DTCs cleared');
  sim.dtcs = [];
  return { cleared: true };
}

const SECURITY_LEVELS = {
  immobilizer: { requestSid: '2703', level: 0x03, name: 'immobilizer/SGW' },
  flash: { requestSid: '2705', level: 0x05, name: 'programming' },
};

/**
 * Simulated UDS SecurityAccess (service 0x27): seed request + key response.
 * On real hardware the seed→key transform is provided by the licensed OEM
 * AutoAuth provider; the simulator derives a deterministic bench key.
 */
function securityAccess(params = {}) {
  requireConnection();
  const scope = params.scope === 'flash' ? 'flash' : 'immobilizer';
  const level = SECURITY_LEVELS[scope];
  const seed = crypto.randomBytes(4).toString('hex').toUpperCase();
  const key = Buffer.from(seed, 'hex').map((b) => (b ^ 0x5a) & 0xff).toString('hex').toUpperCase();
  logEntry('tx', '0x7E0', level.requestSid, `SecurityAccess requestSeed (${level.name})`);
  logEntry('rx', '0x7E8', `67${level.level.toString(16).padStart(2, '0')}${seed}`, 'Seed');
  logEntry('tx', '0x7E0', `27${(level.level + 1).toString(16).padStart(2, '0')}${key}`, 'sendKey');
  logEntry('rx', '0x7E8', `67${(level.level + 1).toString(16).padStart(2, '0')}`, 'SecurityAccess granted');
  sim.security = { scope, unlockedAt: Date.now() };
  return { unlocked: true, scope, level: level.level };
}

function requireSecurity(scope) {
  if (!sim?.security || sim.security.scope !== scope) {
    throw new Error(`SecurityAccess (${scope}) required before this procedure`);
  }
  // Unlock is valid for the length of the session; expire after 10 minutes idle.
  if (Date.now() - sim.security.unlockedAt > 10 * 60 * 1000) {
    sim.security = null;
    throw new Error('SecurityAccess session expired; re-authenticate');
  }
}

function programKey(procedure, params = {}) {
  const payload = verifyProcedureToken(procedure, params);
  requireConnection();
  requireSecurity('immobilizer');
  if (!sim.immobilizer) sim.immobilizer = { keys: [], remotes: [] };
  const routine = {
    add_key: { id: '0x0301', label: 'Program spare key' },
    all_keys_lost: { id: '0x0302', label: 'All keys lost — provision new key' },
    program_remote: { id: '0x0303', label: 'Program RF remote' },
    erase_keys: { id: '0x0304', label: 'Erase and relearn keys' },
  }[procedure];
  logEntry('tx', '0x7E4', `3101${routine.id.slice(2)}`, `RoutineControl start: ${routine.label}`);
  logEntry('rx', '0x7EC', `7101${routine.id.slice(2)}`, 'Routine accepted');
  const now = new Date().toISOString();
  if (procedure === 'erase_keys') {
    sim.immobilizer = { keys: [], remotes: [] };
  } else if (procedure === 'all_keys_lost') {
    sim.immobilizer.keys = [{ id: `key-${Date.now()}`, type: 'transponder', programmedAt: now }];
  } else if (procedure === 'add_key') {
    sim.immobilizer.keys.push({ id: `key-${Date.now()}`, type: 'transponder', programmedAt: now });
  } else if (procedure === 'program_remote') {
    sim.immobilizer.remotes.push({ id: `rke-${Date.now()}`, type: 'rf_hub', programmedAt: now });
  }
  logEntry('rx', '0x7EC', `7103${routine.id.slice(2)}00`, 'Routine result: success');
  return {
    procedure,
    completed: true,
    vin: payload.vin,
    keys: sim.immobilizer.keys.length,
    remotes: sim.immobilizer.remotes.length,
    routine: routine.id,
    completedAt: now,
  };
}

/**
 * Simulated ECU reflash via the UDS programming sequence:
 * RequestDownload (0x34) -> TransferData (0x36) chunks -> RequestTransferExit
 * (0x37). Returns per-block progress so the UI can render a progress bar.
 */
function flashModule(params = {}) {
  const payload = verifyProcedureToken('module_flash', params);
  requireConnection();
  requireSecurity('flash');
  const target = String(params.target || '0x7E1');
  const firmware = params.firmware || {};
  const size = Math.max(1, Number(firmware.size) || (firmware.data ? Buffer.byteLength(String(firmware.data), 'base64') : 0));
  if (!size) throw new Error('Firmware payload (size or data) is required for module flash');
  const blockSize = 0x400;
  const blocks = Math.ceil(size / blockSize);
  if (!sim.modules) sim.modules = {};
  logEntry('tx', target, '1002', 'Programming session start (0x10 0x02)');
  logEntry('rx', target.replace('0x7E', '0x7E8'), '5002', 'Programming session active');
  logEntry('tx', target, `34${(size).toString(16).padStart(8, '0')}`, `RequestDownload: ${size} bytes`);
  logEntry('rx', target.replace('0x7E', '0x7E8'), '7420', 'Download accepted, maxBlock=0x0400');
  const progress = [];
  for (let index = 1; index <= blocks; index += 1) {
    const seq = (index & 0xff).toString(16).padStart(2, '0');
    logEntry('tx', target, `36${seq}`, `TransferData block ${index}/${blocks}`);
    logEntry('rx', target.replace('0x7E', '0x7E8'), `76${seq}`, 'Block accepted');
    progress.push({ block: index, blocks, percent: Math.round((index / blocks) * 100) });
  }
  logEntry('tx', target, '37', 'RequestTransferExit');
  logEntry('rx', target.replace('0x7E', '0x7E8'), '77', 'Transfer complete');
  logEntry('tx', target, '3101FF01', 'RoutineControl: verify programming dependencies');
  logEntry('rx', target.replace('0x7E', '0x7E8'), '7101FF0100', 'Verification passed');
  const version = firmware.version || `sim-${Date.now()}`;
  sim.modules[target] = { softwareVersion: version, flashedAt: new Date().toISOString(), bytes: size };
  return {
    procedure: 'module_flash',
    completed: true,
    vin: payload.vin,
    target,
    bytes: size,
    blocks,
    softwareVersion: version,
    progress,
    completedAt: sim.modules[target].flashedAt,
  };
}

const BIDIRECTIONAL_CONTROLS = {
  cooling_fan: { did: 'D100', option: '03', label: 'Cooling fan' },
  fuel_pump: { did: 'D101', option: '03', label: 'Fuel pump' },
  ac_clutch: { did: 'D102', option: '03', label: 'A/C clutch' },
  evap_purge: { did: 'D103', option: '03', label: 'EVAP purge' },
  return_control: { did: 'D100', option: '00', label: 'Return control to ECU' },
};

function bidirectionalControl(params = {}) {
  const payload = verifyProcedureToken('bidirectional_control', params);
  requireConnection();
  const control = BIDIRECTIONAL_CONTROLS[String(params.control || '')];
  if (!control) throw new Error('Unsupported bidirectional control');
  const option = params.state === 'off' || params.control === 'return_control' ? '00' : control.option;
  logEntry('tx', '0x7E0', '1003', 'Extended diagnostic session (0x10 0x03)');
  logEntry('rx', '0x7E8', '5003', 'Extended session active');
  logEntry('tx', '0x7E0', `2F${control.did}${option}`, `InputOutputControl: ${control.label}`);
  logEntry('rx', '0x7E8', `6F${control.did}${option}`, 'Control accepted');
  return {
    procedure: 'bidirectional_control',
    completed: true,
    vin: payload.vin,
    control: params.control,
    state: option === '00' ? 'released' : 'active',
  };
}

function codeModule(params = {}) {
  const payload = verifyProcedureToken('module_coding', params);
  requireConnection();
  requireSecurity('flash');
  const did = String(params.did || '').replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(did)) throw new Error('Coding identifier must be a 4-digit hex DID');
  const data = String(params.data || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{2,128}$/.test(data) || data.length % 2) throw new Error('Coding data must be even-length hex, up to 64 bytes');
  const target = String(params.target || '0x7E0');
  logEntry('tx', target, `2E${did}${data}`, 'WriteDataByIdentifier');
  logEntry('rx', target, `6E${did}`, 'Coding accepted');
  if (!sim.coding) sim.coding = {};
  sim.coding[`${target}:${did}`] = data;
  return {
    procedure: 'module_coding',
    completed: true,
    vin: payload.vin,
    target,
    did: `0x${did}`,
    bytes: data.length / 2,
  };
}

function pollLiveLog(since = 0) {
  if (!sim) return { entries: [] };
  const entries = sim.commLog.filter((e) => e.timestamp > since);
  if (sim.liveLogActive && sim.connected) {
    const rpm = 750 + Math.floor(Math.random() * 200);
    logEntry('rx', '0x7E8', `410C${rpm.toString(16).padStart(4, '0').toUpperCase()}`, `Engine RPM: ${rpm}`);
  }
  return { entries: entries.length ? entries : sim.commLog.slice(-5) };
}

function identifyVehicle() {
  requireConnection();
  const { ecus, securityModules, networkTopology } = identifyEcus();
  const vinResult = readVin();
  const sessionId = `diag-${Date.now()}`;
  return {
    sessionId,
    vin: vinResult.vin,
    make: 'Ram',
    modelYear: 2020,
    platform: SIM_PLATFORM,
    ignitionType: 'push_button',
    ecus,
    securityModules,
    networkTopology,
    identifiedAt: new Date().toISOString(),
    adapterInfo: {
      vendor: sim.adapterId === 'simulator' ? 'MechPro' : 'J2534',
      dll: sim.adapterId === 'simulator' ? 'builtin-simulator' : sim.adapterId,
      firmware: '1.0.0',
    },
  };
}

function handleConnection(socket) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const response = handleRequest(req);
      socket.write(`${JSON.stringify(response)}\n`);
    }
  });
}

function startServer() {
  if (process.platform === 'win32') {
    const server = net.createServer(handleConnection);
    server.listen(PIPE_NAME, () => {
      process.stdout.write(`J2534 host listening on ${PIPE_NAME}\n`);
    });
    return server;
  }
  const socketPath = PIPE_NAME;
  if (fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  }
  const server = net.createServer(handleConnection);
  server.listen(socketPath, () => {
    process.stdout.write(`J2534 host listening on ${socketPath}\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`J2534 host error: ${err.message}\n`);
    process.exit(1);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, PIPE_NAME, handleRequest };
