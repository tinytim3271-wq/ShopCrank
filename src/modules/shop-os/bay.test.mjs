import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKeyJobAllowed,
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
