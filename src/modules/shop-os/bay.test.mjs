import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKeyJobAllowed,
  assertLiveKeySession,
  keyAuditRecord,
  keyConfirmationMatches,
  liveKeyProcedureFor,
  isRoAuthorizedForKeys,
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

const liveOrder = { id: "RO-2001", vehicle: "2021 Ram 1500", customer: "Demo Customer", vin: "1C6SRFHT0LN123456" };
const liveSigned = [{ id: "EST-9", workOrderId: "RO-2001", status: "approved", signedAt: "2026-10-01T15:00:00.000Z", authorizationName: "Demo Customer" }];

test("live key sessions need a signed RO, a connected adapter, and a matching VIN", () => {
  const base = { order: liveOrder, estimates: liveSigned, operation: "add", vehicleVin: liveOrder.vin, deviceConnected: true };
  assert.equal(assertLiveKeySession(base).id, "EST-9");
  assert.throws(() => assertLiveKeySession({ ...base, estimates: [] }), /signed repair order/i);
  assert.throws(() => assertLiveKeySession({ ...base, deviceConnected: false }), /Connect the J2534 adapter/);
  assert.throws(() => assertLiveKeySession({ ...base, vehicleVin: "1C6SRFHT0LN999999" }), /does not match/);
  assert.throws(() => assertLiveKeySession({ ...base, vehicleVin: "" }), /Could not read the VIN/);
  assert.throws(() => assertLiveKeySession({ ...base, order: { ...liveOrder, vin: "" } }), /Add the 17-character VIN/);
  assert.throws(() => assertLiveKeySession({ ...base, notes: "immobilizer bypass please" }), /not available/);
});

test("live key confirmation requires the last six VIN characters", () => {
  assert.equal(keyConfirmationMatches(liveOrder.vin, "123456"), true);
  assert.equal(keyConfirmationMatches(liveOrder.vin, " 12 3456 "), true);
  assert.equal(keyConfirmationMatches(liveOrder.vin, "123457"), false);
  assert.equal(keyConfirmationMatches("SHORT", "SHORT"), false);
});

test("only add and program map to live write procedures", () => {
  assert.equal(liveKeyProcedureFor("add"), "add_key");
  assert.equal(liveKeyProcedureFor("program"), "program_remote");
  assert.equal(liveKeyProcedureFor("identify"), null);
  assert.equal(liveKeyProcedureFor("test"), null);
});

test("key audit records capture who, which RO and VIN, each step and the result", () => {
  const record = keyAuditRecord({
    id: "key-1",
    order: liveOrder,
    user: { id: "u1", name: "Tech One", email: "tech@example.com", role: "technician", pin: "9999" },
    operation: "add",
    procedure: "add_key",
    vehicleVin: liveOrder.vin.toLowerCase(),
    adapter: "RLink",
    authorization: liveSigned[0],
    steps: [{ at: "t1", step: "Read VIN from vehicle", detail: liveOrder.vin }],
    result: "not_supported",
    message: "No verified procedure",
    now: "t2",
  });
  assert.equal(record.performedBy.name, "Tech One");
  assert.equal(record.vehicleVin, liveOrder.vin);
  assert.equal(record.authorizationName, "Demo Customer");
  assert.equal(record.steps.length, 1);
  assert.equal(record.result, "not_supported");
  assert.equal(record.simulated, false);
  assert.equal(JSON.stringify(record).includes("9999"), false);
});
