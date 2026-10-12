const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const hostToken = 'test-host-token';
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\mechpro-j2534-test-${process.pid}`
  : path.join(os.tmpdir(), `mechpro-j2534-test-${process.pid}.sock`);

// ECDSA P-256 signing pair: host verifies with the public key; tests mint with
// the private key (standing in for the Worker).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const { mintCapabilityToken } = require('../capability-token');
const SIM_VIN = '1C6SRFHT0LN123456';

function mint(procedure, overrides = {}) {
  return mintCapabilityToken(privatePem, {
    procedure, vin: SIM_VIN, shopId: 'test-shop', mode: 'simulate', ...overrides,
  }).token;
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, authToken: hostToken } })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      socket.end();
      const response = JSON.parse(buffer.trim());
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
    socket.on('error', reject);
  });
}

async function run() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js')], {
    env: {
      ...process.env,
      MECHPRO_J2534_PIPE: socketPath,
      MECHPRO_J2534_TOKEN: hostToken,
      DIAGNOSTICS_SIGNING_PUBLIC_KEY: publicPem,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ready = false;
  for (let attempt = 0; attempt < 25 && !ready; attempt += 1) {
    try {
      await rpc('ping');
      ready = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!ready) throw new Error('host start timeout');

  assert.equal((await rpc('ping')).ok, true);
  assert.ok((await rpc('listAdapters')).adapters.length >= 1);

  const connect = await rpc('connect', { adapterId: 'simulator', protocol: 'ISO15765' });
  assert.equal(connect.connected, true);
  assert.ok(connect.voltage > 11);

  const vin = await rpc('readVin');
  assert.equal(vin.vin.length, 17);
  const vehicle = await rpc('identifyVehicle');
  assert.equal(vehicle.vin, vin.vin);
  assert.ok(Array.isArray((await rpc('readDtcs')).dtcs));

  // --- generic OBD-II for the OBD bay (simulator) ---
  const snapshot = await rpc('obdSnapshot');
  assert.equal(snapshot.source, 'simulator');
  assert.equal(snapshot.vin, vin.vin);
  assert.ok(snapshot.readings.length > 0);
  await assert.rejects(() => rpc('obdClearDtcs'), /Confirm before clearing/);
  assert.equal((await rpc('obdClearDtcs', { confirmed: true })).cleared, true);
  assert.deepEqual((await rpc('obdSnapshot')).storedDtcs, []);
  const keySupport = await rpc('keyProcedureSupport', { procedure: 'add_key' });
  assert.equal(keySupport.supported, true);
  assert.equal(keySupport.simulator, true);
  assert.equal((await rpc('keyProcedureSupport', { procedure: 'bypass' })).supported, false);

  // --- clear DTCs capability-token gating ---
  await assert.rejects(() => rpc('clearDtcs'), /capability token/i);
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: 'not-a-real-token' }), /capability token/i);
  // Wrong procedure scope is rejected.
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: mint('add_key') }), /not valid for clear_dtcs/i);
  // LIVE-mode token is rejected by the simulator host (mode mismatch).
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: mint('clear_dtcs', { mode: 'live' }) }), /mode mismatch/i);
  // Tampered signature is rejected.
  const tampered = `${mint('clear_dtcs').slice(0, -3)}AAA`;
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: tampered }), /signature|token/i);
  // Expired token is rejected.
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: mint('clear_dtcs', { ttlMs: -1000 }) }), /expired/i);

  const clearToken = mint('clear_dtcs');
  assert.equal((await rpc('clearDtcs', { authorizationToken: clearToken })).cleared, true);
  await assert.rejects(() => rpc('clearDtcs', { authorizationToken: clearToken }), /already used/i);

  // --- key programming (immobilizer) ---
  // Programming requires SecurityAccess first.
  await assert.rejects(() => rpc('addKey', { authorizationToken: mint('add_key') }), /SecurityAccess.*required/i);
  const sec = await rpc('securityAccess', { scope: 'immobilizer' });
  assert.equal(sec.unlocked, true);

  const added = await rpc('addKey', { authorizationToken: mint('add_key') });
  assert.equal(added.completed, true);
  assert.equal(added.keys, 1);
  const added2 = await rpc('addKey', { authorizationToken: mint('add_key') });
  assert.equal(added2.keys, 2);
  const remote = await rpc('programRemote', { authorizationToken: mint('program_remote') });
  assert.equal(remote.remotes, 1);
  const akl = await rpc('allKeysLost', { authorizationToken: mint('all_keys_lost') });
  assert.equal(akl.completed, true);
  assert.equal(akl.keys, 1); // AKL provisions a single fresh key

  // --- module flash ---
  // Flash needs the programming (flash) security scope, not immobilizer.
  await assert.rejects(
    () => rpc('flashModule', { authorizationToken: mint('module_flash'), target: '0x7E1', firmware: { size: 4096 } }),
    /SecurityAccess \(flash\) required/i,
  );
  await assert.rejects(
    () => rpc('codeModule', { authorizationToken: mint('module_coding'), did: 'F190', data: '01' }),
    /SecurityAccess \(flash\) required/i,
  );
  const secFlash = await rpc('securityAccess', { scope: 'flash' });
  assert.equal(secFlash.scope, 'flash');
  const flashed = await rpc('flashModule', {
    authorizationToken: mint('module_flash'),
    target: '0x7E1',
    firmware: { size: 4096, version: 'DT_ECM_5.7L_v2' },
  });
  assert.equal(flashed.completed, true);
  assert.equal(flashed.bytes, 4096);
  assert.ok(flashed.blocks >= 4);
  assert.equal(flashed.progress[flashed.progress.length - 1].percent, 100);
  assert.equal(flashed.softwareVersion, 'DT_ECM_5.7L_v2');

  const coded = await rpc('codeModule', {
    authorizationToken: mint('module_coding'),
    target: '0x7E0',
    did: 'F190',
    data: '0102',
  });
  assert.equal(coded.completed, true);
  assert.equal(coded.bytes, 2);
  const fan = await rpc('bidirectionalControl', {
    authorizationToken: mint('bidirectional_control'),
    control: 'cooling_fan',
  });
  assert.equal(fan.completed, true);
  assert.equal(fan.state, 'active');
  const released = await rpc('bidirectionalControl', {
    authorizationToken: mint('bidirectional_control'),
    control: 'return_control',
  });
  assert.equal(released.state, 'released');

  // Communication log captured the UDS programming frames.
  const log = await rpc('pollLiveLog', { since: 0 });
  assert.ok(log.entries.some((e) => e.data.startsWith('34')), 'expected RequestDownload frame');
  assert.ok(log.entries.some((e) => e.data.startsWith('36')), 'expected TransferData frame');

  child.kill();
  console.log('j2534 host tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
