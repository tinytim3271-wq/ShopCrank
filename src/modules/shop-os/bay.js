/** Shop-bay helpers for OBD-II scans and repair-order-gated key jobs. */

export const KEY_OPERATIONS = [
  { id: "identify", label: "Identify" },
  { id: "add", label: "Add key" },
  { id: "program", label: "Program remote" },
  { id: "test", label: "Test" },
];

const FORBIDDEN_KEY_REQUEST = /bypass|clon(?:e|ing)|rolling[-\s]?code|stolen|immobilizer\s+bypass|\bfrp\b/i;
const LIVE_KEY_PROCEDURES = Object.freeze({ add: 'add_key', program: 'program_remote' });

export const ELM_SNAPSHOT_PIDS = [
  { pid: 0x04, code: '0x04', command: '0104', name: 'Calculated engine load', unit: '%' },
  { pid: 0x05, code: '0x05', command: '0105', name: 'Coolant temperature', unit: 'C' },
  { pid: 0x0B, code: '0x0B', command: '010B', name: 'Intake manifold pressure', unit: 'kPa' },
  { pid: 0x0C, code: '0x0C', command: '010C', name: 'Engine speed', unit: 'rpm' },
  { pid: 0x0D, code: '0x0D', command: '010D', name: 'Vehicle speed', unit: 'km/h' },
  { pid: 0x0F, code: '0x0F', command: '010F', name: 'Intake air temperature', unit: 'C' },
  { pid: 0x10, code: '0x10', command: '0110', name: 'Mass air flow', unit: 'g/s' },
  { pid: 0x11, code: '0x11', command: '0111', name: 'Throttle position', unit: '%' },
  { pid: 0x2F, code: '0x2F', command: '012F', name: 'Fuel level', unit: '%' },
  { pid: 0x42, code: '0x42', command: '0142', name: 'Control module voltage', unit: 'V' },
];

/**
 * Live/simulator key work is gated by the order's Worker-validated
 * estimateApproval (signature with signedAt). The separate estimates register
 * is not trusted — those fields are client-writable without server checks.
 */
export function signedEstimateForOrder(order, _estimates = []) {
  if (!order?.id) return null;
  const approval = order.estimateApproval;
  if (
    approval
    && approval.status === "approved"
    && approval.signedAt
    && String(approval.authorizationName || "").trim()
  ) {
    return {
      id: order.id,
      workOrderId: order.id,
      status: "approved",
      signedAt: approval.signedAt,
      authorizationName: approval.authorizationName,
      signatureKey: approval.signatureKey || null,
      type: approval.type || "signature",
    };
  }
  return null;
}

export function isRoAuthorizedForKeys(order, estimates = []) {
  return Boolean(signedEstimateForOrder(order, estimates));
}

export function assertKeyJobAllowed({ order, estimates, operation, notes, liveProgrammer = false }) {
  const request = `${operation || ""} ${notes || ""}`;
  if (FORBIDDEN_KEY_REQUEST.test(request)) {
    throw new Error("That request is not available. Key work stays on a signed repair order.");
  }
  if (!KEY_OPERATIONS.some((item) => item.id === operation)) {
    throw new Error("Choose identify, add, program, or test.");
  }
  if (!isRoAuthorizedForKeys(order, estimates)) {
    throw new Error("A signed repair order for this vehicle is required before key programming.");
  }
  if (liveProgrammer) {
    throw new Error("Live programming needs a shop-licensed programmer. This session stays on the simulator.");
  }
}

export function simulateObdScan(vehicle = {}) {
  const vin = String(vehicle.vin || "SIMULATEDVIN00001").toUpperCase();
  return {
    mode: "simulator",
    label: "Bench simulator. This is not a live adapter reading.",
    vin,
    vehicle: vehicle.vehicle || vehicle.label || "Selected vehicle",
    dtcs: [{ code: "P0420", description: "Catalyst system efficiency below threshold (simulated)" }],
    freezeFrame: { rpm: 780, coolantC: 90, speedKph: 0 },
    readiness: { misfire: "complete", fuel: "complete", catalyst: "incomplete" },
    live: [
      { pid: "rpm", value: 780, unit: "rpm" },
      { pid: "coolant", value: 90, unit: "C" },
    ],
    scannedAt: new Date().toISOString(),
  };
}

export function simulateKeyJob({ operation, vin }) {
  const label = KEY_OPERATIONS.find((item) => item.id === operation)?.label || operation;
  return {
    ok: true,
    simulated: true,
    operation,
    message: `Simulator recorded ${label} for ${vin || "the selected vehicle"}. This is not a live programmer.`,
  };
}

export function liveKeyProcedureFor(operation) {
  return LIVE_KEY_PROCEDURES[operation] || null;
}

export function normalizeVin(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function assertLiveKeySession({ order, estimates = [], operation, notes, vehicleVin, deviceConnected }) {
  assertKeyJobAllowed({ order, estimates, operation, notes });
  if (!deviceConnected) throw new Error('Connect the J2534 adapter in the ShopCrank desktop app before a live key job.');
  const roVin = normalizeVin(order?.vin);
  if (roVin.length !== 17) throw new Error('Add the 17-character VIN to this repair order before a live key job.');
  const carVin = normalizeVin(vehicleVin);
  if (carVin.length !== 17) throw new Error('Could not read the VIN from the vehicle. Check the adapter and that the ignition is on.');
  if (carVin !== roVin) throw new Error(`The connected vehicle (${carVin}) does not match the repair order VIN (${roVin}).`);
  return signedEstimateForOrder(order, estimates);
}

export function keyConfirmationMatches(vin, typed) {
  const full = normalizeVin(vin);
  return full.length === 17 && normalizeVin(typed) === full.slice(-6);
}

export function keyAuditRecord({ id, order, user, operation, procedure, vehicleVin, adapter, authorization, notes, steps = [], result, message, now }) {
  return {
    id,
    orderId: order?.id || '',
    roNumber: order?.id || '',
    customer: order?.customer || '',
    vehicle: order?.vehicle || '',
    vin: normalizeVin(order?.vin),
    vehicleVin: normalizeVin(vehicleVin),
    operation,
    procedure: procedure || '',
    notes: String(notes || '').trim(),
    simulated: false,
    mode: 'live',
    adapter: adapter || '',
    performedBy: { id: user?.id || '', name: user?.name || '', email: user?.email || '', role: user?.role || '' },
    authorizationName: authorization?.authorizationName || '',
    authorizationSignedAt: authorization?.signedAt || '',
    estimateId: authorization?.id || '',
    steps: steps.map(item => ({ at: item.at, step: item.step, detail: String(item.detail || '') })),
    result,
    message: message || '',
    createdAt: now,
  };
}

export function elmFrameBytes(line, command = '') {
  let value = String(line || '').toUpperCase().trim();
  if (!value || value.replace(/\s/g, '') === String(command).toUpperCase().replace(/\s/g, '') || /^(SEARCHING|BUS INIT|STOPPED|OK\b|ELM327|AT\b)/.test(value)) {
    return [];
  }
  const numbered = /^\s*\d+\s*:\s*/.test(value);
  value = value.replace(/^\s*\d+\s*:\s*/, '');
  let header = false;
  if (!numbered && /^(?:[67][0-9A-F]{2}|18[0-9A-F]{6})[0-9A-F]{4,}$/.test(value.replace(/\s/g, ''))) {
    const compact = value.replace(/\s/g, '');
    value = compact.slice(compact.startsWith('18') ? 8 : 3);
    header = true;
  }
  let parts = value.match(/[0-9A-F]+/g) || [];
  if (!numbered && !header && parts.length > 1 && (parts[0]?.length === 3 || parts[0]?.length === 8)) {
    parts.shift();
    header = true;
  }
  if (parts.length === 1 && parts[0].length % 2 === 0) {
    parts = parts[0].match(/../g) || [];
  } else {
    parts = parts.flatMap(part => (part.length === 2 ? [part] : part.length % 2 === 0 ? (part.match(/../g) || []) : []));
  }
  let bytes = parts.map(part => parseInt(part, 16)).filter(Number.isFinite);
  if (numbered) return bytes;
  if (header && bytes.length && bytes[0] <= 0x0f) bytes.shift();
  if (bytes[0] >= 0x10 && bytes[0] <= 0x1f) bytes = bytes.slice(2);
  else if (bytes[0] >= 0x20 && bytes[0] <= 0x2f) bytes = bytes.slice(1);
  else if (bytes[0] <= 0x0f && bytes[0] === bytes.length - 1) bytes = bytes.slice(1);
  return bytes;
}

export function parseElmPayload(raw, command = '') {
  const text = String(raw ?? '').trim();
  const upper = text.toUpperCase();
  const noData = /\bNO\s*DATA\b/.test(upper);
  const adapterError = (upper.match(/\b(?:UNABLE TO CONNECT|BUS ERROR|CAN ERROR|BUFFER FULL|ERROR)\b/) || [])[0] || '';
  const lines = text.replace(/>/g, '\n').split(/[\r\n]+/);
  const frames = lines.map(line => elmFrameBytes(line, command)).filter(frame => frame.length);
  const bytes = frames.flat();
  return { raw: text, noData, adapterError, frames, bytes };
}

function findServiceReply(bytes, responseService, pid) {
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === responseService && (pid === undefined || bytes[index + 1] === pid)) {
      return bytes.slice(index + (pid === undefined ? 1 : 2));
    }
  }
  return null;
}

export function formatDtcBytes(first, second) {
  const systems = ['P', 'C', 'B', 'U'];
  const system = systems[(first & 0xc0) >> 6];
  const digit = (first & 0x30) >> 4;
  return `${system}${digit}${(first & 0x0f).toString(16).toUpperCase()}${second.toString(16).padStart(2, '0').toUpperCase()}`;
}

export function parseElmModeDtcs(raw, mode = 0x03) {
  const cmd = mode.toString(16).padStart(2, '0').toUpperCase();
  const parsed = parseElmPayload(raw, cmd);
  if (parsed.noData) return [];
  if (parsed.adapterError) throw new Error(`Adapter reported ${parsed.adapterError}`);
  const markerByte = 0x40 + mode;
  const replies = [];
  let current = null;
  for (const frame of parsed.frames) {
    const marker = frame.indexOf(markerByte);
    if (marker >= 0) {
      const after = frame.slice(marker + 1);
      // CAN ISO 15765-4 mode 03/07/0A includes a count byte when total bytes after 0x43/0x47/0x4A is odd
      const payload = after.length % 2 === 1 ? after.slice(1) : after;
      current = [...payload];
      replies.push(current);
    } else if (current) {
      current.push(...frame);
    }
  }
  const codes = [];
  for (const data of replies) {
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      codes.push(formatDtcBytes(data[i], data[i + 1]));
    }
  }
  return [...new Set(codes)];
}

export function parseElmClearDtcs(raw) {
  const parsed = parseElmPayload(raw, '04');
  if (parsed.adapterError) throw new Error(`Adapter reported ${parsed.adapterError}`);
  if (parsed.noData) throw new Error('Vehicle ECU returned NO DATA for Mode 04 clear codes');
  const rejected = parsed.frames.find(frame => frame[0] === 0x7f && frame[1] === 0x04);
  if (rejected) {
    const nrc = (rejected[2] ?? 0).toString(16).padStart(2, '0').toUpperCase();
    throw new Error(`Vehicle ECU rejected Mode 04 clear codes (NRC 0x${nrc})`);
  }
  if (!parsed.frames.some(frame => frame[0] === 0x44)) {
    throw new Error('Vehicle ECU did not confirm Mode 04 code clear');
  }
  return { ok: true };
}

export function parseElmVin(raw) {
  const parsed = parseElmPayload(raw, '0902');
  if (parsed.noData || parsed.adapterError || !parsed.bytes.length) return '';
  const ascii = parsed.bytes
    .filter(byte => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A))
    .map(byte => String.fromCharCode(byte))
    .join('');
  // Remove leading 'I' if 0x49 ('I') from 49 02 header was included in ASCII range
  const cleaned = normalizeVin(ascii);
  return cleaned.length >= 17 ? cleaned.slice(-17) : '';
}

export function parseElmMonitorStatus(raw) {
  const parsed = parseElmPayload(raw, '0101');
  if (parsed.noData || parsed.adapterError) return null;
  const data = findServiceReply(parsed.bytes, 0x41, 0x01);
  if (!data || data.length < 1) return null;
  const a = data[0];
  return {
    milOn: Boolean(a & 0x80),
    dtcCount: a & 0x7f,
  };
}

export function decodeElmPidReading(pid, raw) {
  const meta = ELM_SNAPSHOT_PIDS.find(item => item.pid === pid);
  if (!meta) return null;
  const parsed = parseElmPayload(raw, meta.command);
  if (parsed.noData || parsed.adapterError) return null;
  const data = findServiceReply(parsed.bytes, 0x41, pid);
  if (!data || !data.length) return null;
  const A = data[0];
  const B = data[1] ?? 0;
  const AB = A * 256 + B;
  let value = null;
  switch (pid) {
    case 0x04:
    case 0x11:
    case 0x2F:
      value = Math.round((A * 100) / 255 * 10) / 10;
      break;
    case 0x05:
    case 0x0F:
      value = A - 40;
      break;
    case 0x0B:
    case 0x0D:
      value = A;
      break;
    case 0x0C:
      if (data.length < 2) return null;
      value = Math.round((AB / 4) * 10) / 10;
      break;
    case 0x10:
      if (data.length < 2) return null;
      value = Math.round((AB / 100) * 100) / 100;
      break;
    case 0x42:
      if (data.length < 2) return null;
      value = Math.round((AB / 1000) * 100) / 100;
      break;
    default:
      return null;
  }
  return {
    pid: meta.code,
    name: meta.name,
    value,
    unit: meta.unit,
    raw: data.slice(0, 2).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
  };
}

export async function runElmObdSnapshot(sendCommand) {
  const errors = [];
  let vin = '';
  try {
    vin = parseElmVin(await sendCommand('0902'));
  } catch (error) {
    errors.push(`VIN: ${error.message}`);
  }

  let monitor = null;
  try {
    monitor = parseElmMonitorStatus(await sendCommand('0101'));
  } catch (error) {
    errors.push(`Monitor status: ${error.message}`);
  }

  const readings = [];
  for (const item of ELM_SNAPSHOT_PIDS) {
    try {
      const reading = decodeElmPidReading(item.pid, await sendCommand(item.command));
      if (reading) readings.push(reading);
    } catch (error) {
      errors.push(`${item.name}: ${error.message}`);
    }
  }

  let storedDtcs = [];
  let pendingDtcs = [];
  let permanentDtcs = [];
  try { storedDtcs = parseElmModeDtcs(await sendCommand('03'), 0x03); } catch (error) { errors.push(`Stored codes: ${error.message}`); }
  try { pendingDtcs = parseElmModeDtcs(await sendCommand('07'), 0x07); } catch (error) { errors.push(`Pending codes: ${error.message}`); }
  try { permanentDtcs = parseElmModeDtcs(await sendCommand('0A'), 0x0A); } catch { /* Mode 0A optional */ }

  let voltage = null;
  try {
    const rawVolt = await sendCommand('ATRV');
    const match = /(\d+(?:\.\d+)?)\s*V/i.exec(String(rawVolt || ''));
    if (match) voltage = Number(match[1]);
  } catch { /* ignore ATRV failure */ }

  const responded = Boolean(vin || monitor || readings.length || storedDtcs.length || pendingDtcs.length || permanentDtcs.length);
  if (!responded && !errors.length) {
    errors.push('No reply from the vehicle ECU. Verify ignition is ON and the OBD-II connector is seated.');
  }

  return {
    source: 'live',
    simulator: false,
    adapterName: 'ELM327 OBD-II adapter',
    protocol: 'SAE J1979 OBD-II (ELM327 Serial)',
    responded,
    vin,
    milOn: monitor?.milOn ?? null,
    reportedDtcCount: monitor?.dtcCount ?? storedDtcs.length,
    supportedPids: readings.map(r => r.pid),
    readings,
    storedDtcs,
    pendingDtcs,
    permanentDtcs,
    errors,
    voltage,
    readAt: new Date().toISOString(),
  };
}
