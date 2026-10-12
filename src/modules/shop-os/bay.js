/** Shop-bay helpers for simulated OBD scans and repair-order-gated key jobs. */

export const KEY_OPERATIONS = [
  { id: "identify", label: "Identify" },
  { id: "add", label: "Add key" },
  { id: "program", label: "Program remote" },
  { id: "test", label: "Test" },
];

const FORBIDDEN_KEY_REQUEST = /bypass|clon(?:e|ing)|rolling[-\s]?code|stolen|immobilizer\s+bypass|\bfrp\b/i;

export function signedEstimateForOrder(order, estimates = []) {
  if (!order?.id) return null;
  return estimates.find((estimate) => (
    estimate.workOrderId === order.id
    && estimate.status === "approved"
    && estimate.signedAt
    && String(estimate.authorizationName || "").trim()
  )) || null;
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

/** Live procedures the key bay can request from the J2534 host. Identify and test are read-only. */
export const LIVE_KEY_PROCEDURES = Object.freeze({ add: "add_key", program: "program_remote" });

export function liveKeyProcedureFor(operation) {
  return LIVE_KEY_PROCEDURES[operation] || null;
}

export function normalizeVin(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Gate for a live key session: signed repair order, a connected adapter, and the
 * VIN read from the vehicle matching the repair order. Returns the signed estimate.
 */
export function assertLiveKeySession({ order, estimates = [], operation, notes, vehicleVin, deviceConnected }) {
  assertKeyJobAllowed({ order, estimates, operation, notes });
  if (!deviceConnected) throw new Error("Connect the J2534 adapter in the MechPro desktop app before a live key job.");
  const roVin = normalizeVin(order?.vin);
  if (roVin.length !== 17) throw new Error("Add the 17-character VIN to this repair order before a live key job.");
  const carVin = normalizeVin(vehicleVin);
  if (carVin.length !== 17) throw new Error("Could not read the VIN from the vehicle. Check the adapter and that the ignition is on.");
  if (carVin !== roVin) throw new Error(`The connected vehicle (${carVin}) does not match the repair order VIN (${roVin}).`);
  return signedEstimateForOrder(order, estimates);
}

export function keyConfirmationMatches(vin, typed) {
  const full = normalizeVin(vin);
  return full.length === 17 && normalizeVin(typed) === full.slice(-6);
}

/** Audit record for one live key session. Never stores the immobilizer PIN. */
export function keyAuditRecord({ id, order, user, operation, procedure, vehicleVin, adapter, authorization, notes, steps = [], result, message, now }) {
  return {
    id,
    orderId: order?.id || "",
    roNumber: order?.id || "",
    customer: order?.customer || "",
    vehicle: order?.vehicle || "",
    vin: normalizeVin(order?.vin),
    vehicleVin: normalizeVin(vehicleVin),
    operation,
    procedure: procedure || "",
    notes: String(notes || "").trim(),
    simulated: false,
    mode: "live",
    adapter: adapter || "",
    performedBy: { id: user?.id || "", name: user?.name || "", email: user?.email || "", role: user?.role || "" },
    authorizationName: authorization?.authorizationName || "",
    authorizationSignedAt: authorization?.signedAt || "",
    estimateId: authorization?.id || "",
    steps: steps.map((item) => ({ at: item.at, step: item.step, detail: String(item.detail || "") })),
    result,
    message: message || "",
    createdAt: now,
  };
}
