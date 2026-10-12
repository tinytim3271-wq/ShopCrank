const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { resolveDiagnosticsPublicKey } = require('./diagnostics-secrets');
const { verifyCapabilityToken } = require('../diagnostics/j2534-host-node/capability-token');

const sessionId = crypto.randomBytes(8).toString('hex');
const hostToken = crypto.randomBytes(24).toString('base64url');
const PIPE_WIN = `\\\\.\\pipe\\mechpro-j2534-${sessionId}`;
const PIPE_UNIX = path.join(os.tmpdir(), `mechpro-j2534-${sessionId}.sock`);

let hostProcess = null;
let requestId = 0;
let powerSaveBlockerId = null;
let appliedPublicKey = false;

function pipePath() {
  return process.platform === 'win32' ? PIPE_WIN : PIPE_UNIX;
}

function csharpPipeName() {
  return `mechpro-j2534-${sessionId}`;
}

function hostScriptPath() {
  const candidates = [
    path.join(__dirname, '..', 'diagnostics', 'j2534-host-node', 'bin', 'start.js'),
  ];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, 'j2534-host-node', 'bin', 'start.js'));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
}

function csharpHostPath() {
  const { app } = require('electron');
  const packaged = path.join(process.resourcesPath, 'j2534-host', 'J2534.Host.exe');
  if (app?.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'diagnostics', 'j2534-service', 'publish', 'win-x64', 'J2534.Host.exe');
}

/**
 * Resolve the capability-token PUBLIC verification key and apply it to
 * process.env so the host process (Node or .NET) can verify Worker-issued
 * tokens. Only the public key is present on the client; it cannot mint tokens.
 * Never throws when the key is missing — read-only J2534 ops must still work.
 */
function diagnosticsPublicKey() {
  const { publicKey, source } = resolveDiagnosticsPublicKey();
  if (publicKey && !appliedPublicKey) {
    process.env.DIAGNOSTICS_SIGNING_PUBLIC_KEY = publicKey;
    appliedPublicKey = true;
  }
  if (!publicKey && source === 'missing-packaged') {
    process.stderr.write(
      '[j2534] DIAGNOSTICS_SIGNING_PUBLIC_KEY missing from packaged build; authorized procedures disabled\n',
    );
  }
  return publicKey;
}

function startHostProcess() {
  if (hostProcess) return hostProcess;

  const csharp = csharpHostPath();
  const publicKey = diagnosticsPublicKey();
  const hostEnv = {
    ...process.env,
    MECHPRO_J2534_PIPE: process.platform === 'win32' ? csharpPipeName() : pipePath(),
    MECHPRO_J2534_TOKEN: hostToken,
  };
  if (publicKey) {
    hostEnv.DIAGNOSTICS_SIGNING_PUBLIC_KEY = publicKey;
  }

  if (process.platform === 'win32' && fs.existsSync(csharp)) {
    hostProcess = spawn(csharp, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: hostEnv,
    });
  } else {
    const script = hostScriptPath();
    if (!fs.existsSync(script)) {
      throw new Error(
        `J2534 host script not found at ${script}. Reinstall MechPro Desktop or run from a full checkout.`,
      );
    }
    hostProcess = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...hostEnv,
        MECHPRO_J2534_PIPE: pipePath(),
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  }

  hostProcess.stdout?.on('data', (chunk) => process.stdout.write(`[j2534] ${chunk}`));
  hostProcess.stderr?.on('data', (chunk) => process.stderr.write(`[j2534] ${chunk}`));
  hostProcess.on('exit', (code) => {
    process.stderr.write(`[j2534] host exited with code ${code}\n`);
    hostProcess = null;
  });
  return hostProcess;
}

async function waitForPipe(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall('ping', {});
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('J2534 diagnostic host did not become ready');
}

function rpcCall(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath());
    const id = ++requestId;
    let buffer = '';
    const payload = { ...params, authToken: hostToken };

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`J2534 RPC timeout: ${method}`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: payload })}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      socket.end();
      clearTimeout(timer);
      try {
        const response = JSON.parse(line);
        if (response.error) reject(new Error(response.error.message || 'RPC error'));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function ensureHost() {
  startHostProcess();
  await waitForPipe();
}

async function listAdapters() {
  await ensureHost();
  return rpcCall('listAdapters');
}

async function connect(params) {
  await ensureHost();
  const result = await rpcCall('connect', params || {});
  if (powerSaveBlockerId === null) {
    const { powerSaveBlocker } = require('electron');
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
  return result;
}

async function disconnect() {
  if (!hostProcess) return { connected: false };
  const result = await rpcCall('disconnect');
  if (powerSaveBlockerId !== null) {
    const { powerSaveBlocker } = require('electron');
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
  return result;
}

async function getConnectionStatus() {
  if (!hostProcess) {
    return { connected: false, adapterId: null, protocol: null, voltage: null, commFault: true };
  }
  try {
    return await rpcCall('getConnectionStatus');
  } catch {
    return { connected: false, adapterId: null, protocol: null, voltage: null, commFault: true };
  }
}

async function readVin() {
  await ensureHost();
  return rpcCall('readVin');
}

async function identifyEcus() {
  await ensureHost();
  return rpcCall('identifyEcus');
}

async function readDtcs() {
  await ensureHost();
  return rpcCall('readDtcs');
}

/**
 * Pre-flight a mutating procedure: ensure the capability public key is present
 * and the token's signature/expiry/procedure are valid before touching the bus.
 * The host enforces single-use consumption, so this check does not consume.
 */
function preflightAuthorization(procedure, params = {}) {
  const authorizationToken = String(params.authorizationToken || '').trim();
  if (!authorizationToken) {
    throw new Error(`${procedure} requires an authorization token from /diagnostics/authorize`);
  }
  if (!diagnosticsPublicKey()) {
    throw new Error(
      `${procedure} is unavailable: the diagnostics capability public key is not configured in this desktop build. Reinstall from Downloads after the shop rebuilds the installer.`,
    );
  }
  verifyCapabilityToken(authorizationToken, { procedure, consume: false });
  return authorizationToken;
}

/** Clear DTCs — requires a cloud /diagnostics/authorize capability token. */
async function clearDtcs(params = {}) {
  const authorizationToken = preflightAuthorization('clear_dtcs', params);
  await ensureHost();
  return rpcCall('clearDtcs', { authorizationToken });
}

/** UDS SecurityAccess (immobilizer or flash scope) — no capability token needed to request a seed. */
async function securityAccess(params = {}) {
  await ensureHost();
  return rpcCall('securityAccess', { scope: params.scope === 'flash' ? 'flash' : 'immobilizer' });
}

const KEY_PROCEDURE_RPC = {
  add_key: 'addKey',
  all_keys_lost: 'allKeysLost',
  program_remote: 'programRemote',
  erase_keys: 'eraseKeys',
};

/** Immobilizer key/remote programming — requires a scoped capability token. */
async function programKey(params = {}) {
  const procedure = String(params.procedure || '').trim();
  const method = KEY_PROCEDURE_RPC[procedure];
  if (!method) throw new Error(`Unsupported key procedure: ${procedure}`);
  const authorizationToken = preflightAuthorization(procedure, params);
  await ensureHost();
  const pin = params.pin ? String(params.pin) : undefined;
  return rpcCall(method, { authorizationToken, pin }, 120000);
}

/** Module coding (WriteDataByIdentifier) — requires a module_coding token and programming security. */
async function codeModule(params = {}) {
  const authorizationToken = preflightAuthorization('module_coding', params);
  await ensureHost();
  return rpcCall('codeModule', {
    authorizationToken,
    target: params.target,
    did: params.did,
    data: params.data,
  });
}

/** Named actuator test (InputOutputControl) — requires a bidirectional_control token. */
async function bidirectionalControl(params = {}) {
  const authorizationToken = preflightAuthorization('bidirectional_control', params);
  await ensureHost();
  return rpcCall('bidirectionalControl', {
    authorizationToken,
    control: params.control,
    state: params.state,
  });
}

/** ECU reflash via the UDS programming sequence — requires a module_flash token. */
async function flashModule(params = {}) {
  const authorizationToken = preflightAuthorization('module_flash', params);
  await ensureHost();
  return rpcCall('flashModule', {
    authorizationToken,
    target: params.target,
    firmware: params.firmware,
  });
}

async function startLiveLog() {
  await ensureHost();
  return rpcCall('startLiveLog');
}

async function stopLiveLog() {
  await ensureHost();
  return rpcCall('stopLiveLog');
}

async function pollLiveLog(since = 0) {
  await ensureHost();
  return rpcCall('pollLiveLog', { since });
}

async function identifyVehicle() {
  await ensureHost();
  return rpcCall('identifyVehicle');
}

/** Generic OBD-II snapshot (VIN, mode 01 PIDs, mode 03/07/0A codes) for the OBD bay. */
async function obdSnapshot() {
  await ensureHost();
  return rpcCall('obdSnapshot', {}, 45000);
}

/** OBD-II mode 04. The OBD bay asks the technician to confirm before calling this. */
async function obdClearDtcs(params = {}) {
  if (params.confirmed !== true) throw new Error('Clearing codes needs explicit confirmation.');
  await ensureHost();
  return rpcCall('obdClearDtcs', { confirmed: true }, 20000);
}

/** Read-only: does MechPro have a verified live key procedure for the connected vehicle? */
async function keyProcedureSupport(params = {}) {
  await ensureHost();
  return rpcCall('keyProcedureSupport', { procedure: String(params.procedure || '') }, 20000);
}

function stopHost() {
  if (hostProcess) {
    hostProcess.kill();
    hostProcess = null;
  }
  if (powerSaveBlockerId !== null) {
    try {
      const { powerSaveBlocker } = require('electron');
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch { /* ignore */ }
    powerSaveBlockerId = null;
  }
}

module.exports = {
  ensureHost,
  listAdapters,
  connect,
  disconnect,
  getConnectionStatus,
  readVin,
  identifyEcus,
  readDtcs,
  clearDtcs,
  securityAccess,
  programKey,
  codeModule,
  bidirectionalControl,
  flashModule,
  startLiveLog,
  stopLiveLog,
  pollLiveLog,
  identifyVehicle,
  obdSnapshot,
  obdClearDtcs,
  keyProcedureSupport,
  stopHost,
};
