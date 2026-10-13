import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLiveKeySession,
  assertKeyJobAllowed,
  keyConfirmationMatches,
  keyAuditRecord,
  liveKeyProcedureFor,
  isRoAuthorizedForKeys,
  normalizeVin,
  simulateKeyJob,
  simulateObdScan,
} from "./bay.js";

const order = {
  id: "RO-1048",
  vehicle: "2018 Ford F-150 XLT",
  vin: "DEMOVIN000000001",
  estimateApproval: {
    status: "approved",
    type: "signature",
    signedAt: "2026-09-28T12:00:00.000Z",
    authorizationName: "Demo Customer A",
  },
};
const unsignedOrder = { id: "RO-1048", vehicle: "2018 Ford F-150 XLT", vin: "DEMOVIN000000001" };
const forgedEstimates = [{
  workOrderId: "RO-1048",
  status: "approved",
  signedAt: "2026-09-28T12:00:00.000Z",
  authorizationName: "Forged Customer",
}];

test("key programming requires a signed repair order estimateApproval", () => {
  assert.equal(isRoAuthorizedForKeys(unsignedOrder, []), false);
  assert.equal(isRoAuthorizedForKeys(unsignedOrder, forgedEstimates), false);
  assert.throws(
    () => assertKeyJobAllowed({ order: unsignedOrder, estimates: forgedEstimates, operation: "identify" }),
    /signed repair order/i,
  );
  assert.doesNotThrow(() => assertKeyJobAllowed({
    order,
    estimates: [],
    operation: "add",
    notes: "Customer is present with the RO",
  }));
});

test("key programming rejects bypass and cloning requests", () => {
  assert.throws(
    () => assertKeyJobAllowed({
      order,
      estimates: [],
      operation: "identify",
      notes: "immobilizer bypass for a stolen car",
    }),
    /not available/i,
  );
  assert.throws(
    () => assertKeyJobAllowed({
      order,
      estimates: [],
      operation: "clone",
      notes: "",
    }),
    /not available|Choose identify/i,
  );
});

test("live programmer mode fails closed", () => {
  assert.throws(
    () => assertKeyJobAllowed({
      order,
      estimates: [],
      operation: "program",
      liveProgrammer: true,
    }),
    /licensed programmer/i,
  );
});

test("simulator results are labeled and do not claim a live tool", () => {
  const scan = simulateObdScan(order);
  assert.equal(scan.mode, "simulator");
  assert.match(scan.label, /not a live adapter/i);
  assert.equal(scan.dtcs[0].code, "P0420");

  const job = simulateKeyJob({ operation: "test", vin: order.vin });
  assert.equal(job.simulated, true);
  assert.match(job.message, /not a live programmer/i);
});

const liveOrder = {
  id: "RO-2001",
  vehicle: "2021 Ram 1500",
  customer: "Demo Customer",
  vin: "1C6SRFHT0LN123456",
  estimateApproval: {
    id: "EST-9",
    status: "approved",
    type: "signature",
    signedAt: "2026-10-01T15:00:00.000Z",
    authorizationName: "Demo Customer",
  },
};

test("live key sessions need a signed RO, a connected adapter, and a matching VIN", () => {
  const base = { order: liveOrder, estimates: [], operation: "add", vehicleVin: liveOrder.vin, deviceConnected: true };
  assert.equal(assertLiveKeySession(base).authorizationName, "Demo Customer");
  assert.equal(liveKeyProcedureFor("add"), "add_key");
  assert.equal(liveKeyProcedureFor("identify"), null);
  assert.throws(() => assertLiveKeySession({ ...base, order: { ...liveOrder, estimateApproval: null } }), /signed repair order/i);
  assert.throws(() => assertLiveKeySession({ ...base, deviceConnected: false }), /Connect the J2534 adapter/);
  assert.throws(() => assertLiveKeySession({ ...base, vehicleVin: "1C6SRFHT0LN999999" }), /does not match/);
  assert.throws(() => assertLiveKeySession({ ...base, vehicleVin: "" }), /Could not read the VIN/);
});

test("VIN confirmation and live key audit records normalize sensitive identifiers", () => {
  assert.equal(normalizeVin("1hg-cm82633a004352"), "1HGCM82633A004352");
  assert.equal(keyConfirmationMatches("1HGCM82633A004352", "004352"), true);
  assert.equal(keyConfirmationMatches(order.vin, "not-it"), false);
  const record = keyAuditRecord({
    id: "audit-1",
    order,
    vehicleVin: "demovin000000001",
    user: { id: "tech-1", name: "Tech", role: "technician" },
    operation: "add",
    authorization: { id: "estimate-1", authorizationName: "Customer", signedAt: "2026-10-01" },
    notes: "  verified  ",
    steps: [{ at: "2026-10-01", step: "identify", detail: " VIN confirmed " }],
    now: "2026-10-01",
  });

  assert.equal(record.vin, "DEMOVIN000000001");
  assert.equal(record.vehicleVin, "DEMOVIN000000001");
  assert.equal(record.notes, "verified");
  assert.equal(record.authorizationName, "Customer");
  assert.equal(record.steps[0].detail, " VIN confirmed ");
});
