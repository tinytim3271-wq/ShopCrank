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
