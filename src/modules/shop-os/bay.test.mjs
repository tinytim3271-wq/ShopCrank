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

const order = { id: "RO-1048", vehicle: "2018 Ford F-150 XLT", vin: "DEMOVIN000000001" };
const signed = [{
  workOrderId: "RO-1048",
  status: "approved",
  signedAt: "2026-09-28T12:00:00.000Z",
  authorizationName: "Demo Customer A",
}];

test("key programming requires a signed repair order", () => {
  assert.equal(isRoAuthorizedForKeys(order, []), false);
  assert.throws(
    () => assertKeyJobAllowed({ order, estimates: [], operation: "identify" }),
    /signed repair order/i,
  );
  assert.doesNotThrow(() => assertKeyJobAllowed({
    order,
    estimates: signed,
    operation: "add",
    notes: "Customer is present with the RO",
  }));
});

test("key programming rejects bypass and cloning requests", () => {
  assert.throws(
    () => assertKeyJobAllowed({
      order,
      estimates: signed,
      operation: "identify",
      notes: "immobilizer bypass for a stolen car",
    }),
    /not available/i,
  );
  assert.throws(
    () => assertKeyJobAllowed({
      order,
      estimates: signed,
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
      estimates: signed,
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

test("live key sessions require an authorized order, connected adapter, and matching VIN", () => {
  const liveOrder = { ...order, vin: "1HGCM82633A004352" };
  assert.equal(liveKeyProcedureFor("add"), "add_key");
  assert.equal(liveKeyProcedureFor("identify"), null);
  assert.throws(
    () => assertLiveKeySession({ order: liveOrder, estimates: signed, operation: "add", vehicleVin: liveOrder.vin, deviceConnected: false }),
    /Connect the J2534 adapter/,
  );
  assert.throws(
    () => assertLiveKeySession({ order: liveOrder, estimates: signed, operation: "add", vehicleVin: "1HGCM82633A004353", deviceConnected: true }),
    /does not match/,
  );
  assert.equal(
    assertLiveKeySession({ order: liveOrder, estimates: signed, operation: "add", vehicleVin: liveOrder.vin, deviceConnected: true }),
    signed[0],
  );
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
