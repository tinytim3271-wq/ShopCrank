import { HttpError } from "./http.mjs";

const PAYMENT_METHODS = new Set(["cash", "card", "check", "bank", "processor", "other"]);
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

function parseEntityRow(row) {
  if (!row?.data_json) return null;
  try {
    return { record: JSON.parse(row.data_json), row };
  } catch {
    return null;
  }
}

async function entityRow(env, shopId, type, id) {
  return parseEntityRow(await env.DB.prepare(`
    SELECT data_json, created_by, created_at, updated_at
    FROM entities
    WHERE shop_id = ? AND entity_type = ? AND entity_id = ?
  `).bind(shopId, type, id).first());
}

async function linkedInvoiceRow(env, shopId, workOrderId) {
  return parseEntityRow(await env.DB.prepare(`
    SELECT data_json, created_by, created_at, updated_at
    FROM entities
    WHERE shop_id = ? AND entity_type = 'invoices'
      AND json_extract(data_json, '$.ro') = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(shopId, workOrderId).first());
}

async function completedPayments(env, shopId, invoiceNumber, workOrderId) {
  const clauses = [];
  const values = [shopId];
  if (invoiceNumber) {
    clauses.push("json_extract(data_json, '$.invoiceNumber') = ?");
    values.push(invoiceNumber);
  }
  if (workOrderId) {
    clauses.push("json_extract(data_json, '$.workOrderId') = ?");
    values.push(workOrderId);
  }
  if (!clauses.length) return [];
  const result = await env.DB.prepare(`
    SELECT data_json
    FROM entities
    WHERE shop_id = ? AND entity_type = 'payments'
      AND json_extract(data_json, '$.status') = 'completed'
      AND (${clauses.join(" OR ")})
  `).bind(...values).all();
  return (result.results || []).map(row => parseEntityRow(row)?.record).filter(Boolean);
}

function entityWriteStatement(env, context, type, id, record, existingRow, now) {
  const createdBy = existingRow?.created_by || context.userId;
  const createdAt = record.createdAt || existingRow?.created_at || now;
  const value = {
    ...record,
    id,
    shopId: context.shopId,
    createdBy,
    createdAt,
    updatedAt: now,
  };
  return {
    value,
    statement: env.DB.prepare(`
      INSERT INTO entities (shop_id, entity_type, entity_id, data_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, entity_type, entity_id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).bind(context.shopId, type, id, JSON.stringify(value), createdBy, createdAt, now),
  };
}

export function paymentStatus(total, paid) {
  const amount = roundMoney(total);
  const collected = Math.min(amount, roundMoney(paid));
  const balance = roundMoney(Math.max(0, amount - collected));
  return {
    total: amount,
    paid: collected,
    balance,
    status: balance === 0 && amount > 0 ? "paid" : collected > 0 ? "partial" : "unpaid",
  };
}

export function normalizePaymentInput(body) {
  const targetType = String(body.targetType || "").trim().toLowerCase();
  const targetId = String(body.targetId || "").trim();
  const amount = roundMoney(body.amount);
  const method = String(body.method || "").trim().toLowerCase();
  if (!["invoice", "work_order"].includes(targetType)) {
    throw new HttpError(400, "targetType must be invoice or work_order");
  }
  if (!targetId) throw new HttpError(400, "targetId is required");
  if (!Number.isFinite(Number(body.amount)) || amount <= 0) {
    throw new HttpError(400, "Payment amount must be greater than zero");
  }
  if (!PAYMENT_METHODS.has(method)) throw new HttpError(400, "Unsupported payment method");
  const received = body.receivedAt ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(received.valueOf())) throw new HttpError(400, "receivedAt must be a valid date and time");
  const stripeChargeId = String(body.stripeChargeId || "").trim().slice(0, 80);
  const stripePaymentIntentId = String(body.stripePaymentIntentId || "").trim().slice(0, 80);
  const stripePaymentId = String(body.stripePaymentId || "").trim().slice(0, 80);
  return {
    targetType,
    targetId,
    amount,
    method,
    receivedAt: received.toISOString(),
    reference: String(body.reference || "").trim().slice(0, 160),
    note: String(body.note || "").trim().slice(0, 500),
    ...(stripeChargeId ? { stripeChargeId } : {}),
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
    ...(stripePaymentId ? { stripePaymentId } : {}),
  };
}

export async function chargeTargetSnapshot(env, context, targetType, targetId) {
  if (!["invoice", "work_order"].includes(targetType)) {
    throw new HttpError(400, "targetType must be invoice or work_order");
  }
  if (!String(targetId || "").trim()) throw new HttpError(400, "targetId is required");
  const entityType = targetType === "invoice" ? "invoices" : "orders";
  const target = await entityRow(env, context.shopId, entityType, targetId);
  if (!target) throw new HttpError(404, targetType === "invoice" ? "Invoice not found" : "Work order not found");
  const invoice = targetType === "invoice" ? target : await linkedInvoiceRow(env, context.shopId, targetId);
  const order = targetType === "work_order"
    ? target
    : target.record.ro
      ? await entityRow(env, context.shopId, "orders", target.record.ro)
      : null;
  const invoiceNumber = invoice?.record.number || invoice?.record.id || "";
  const workOrderId = order?.record.id || invoice?.record.ro || "";
  const total = Number(invoice?.record.amount ?? order?.record.total ?? target.record.amount ?? target.record.total);
  if (!Number.isFinite(total) || total < 0) throw new HttpError(409, "The payment target has no valid total");
  const priorPayments = await completedPayments(env, context.shopId, invoiceNumber, workOrderId);
  const priorRecorded = roundMoney(priorPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  const legacyPaid = targetType === "invoice"
    && target.record.status === "paid"
    && priorRecorded === 0
    && target.record.paymentStatus == null;
  return {
    target,
    invoice,
    order,
    invoiceNumber,
    workOrderId,
    customer: target.record.customer || invoice?.record.customer || order?.record.customer || "",
    vehicle: order?.record.vehicle || target.record.vehicle || "",
    before: paymentStatus(total, legacyPaid ? total : priorRecorded),
  };
}

export async function recordPayment(env, context, body, { paymentId = crypto.randomUUID() } = {}) {
  const input = normalizePaymentInput(body);
  if (await entityRow(env, context.shopId, "payments", paymentId)) {
    throw new HttpError(409, "Payment already recorded");
  }
  const snapshot = await chargeTargetSnapshot(env, context, input.targetType, input.targetId);
  const { target } = snapshot;
  let { invoice, order } = snapshot;
  const { invoiceNumber, workOrderId } = snapshot;
  const before = snapshot.before;
  if (input.amount > before.balance) throw new HttpError(409, "Payment amount exceeds the remaining balance");
  const summary = paymentStatus(before.total, before.paid + input.amount);
  const now = new Date().toISOString();
  const payment = {
    targetType: input.targetType,
    targetId: input.targetId,
    invoiceNumber: invoiceNumber || undefined,
    workOrderId: workOrderId || undefined,
    customer: target.record.customer || invoice?.record.customer || order?.record.customer || "",
    amount: input.amount,
    method: input.method,
    receivedAt: input.receivedAt,
    reference: input.reference,
    note: input.note,
    status: "completed",
    recordedBy: context.userId,
    ...(input.stripeChargeId ? { stripeChargeId: input.stripeChargeId } : {}),
    ...(input.stripePaymentIntentId ? { stripePaymentIntentId: input.stripePaymentIntentId } : {}),
    ...(input.stripePaymentId ? { stripePaymentId: input.stripePaymentId } : {}),
  };

  const writes = [];
  const paymentWrite = entityWriteStatement(env, context, "payments", paymentId, payment, null, now);
  writes.push(paymentWrite.statement);
  if (invoice) {
    const invoiceRecord = {
      ...invoice.record,
      paidAmount: summary.paid,
      balanceDue: summary.balance,
      paymentStatus: summary.status,
      status: summary.status,
      paidAt: summary.status === "paid" ? input.receivedAt : invoice.record.paidAt,
      closedAt: summary.status === "paid" ? input.receivedAt : invoice.record.closedAt,
      closeoutSource: summary.status === "paid" ? "payment_date" : invoice.record.closeoutSource,
    };
    const write = entityWriteStatement(
      env,
      context,
      "invoices",
      invoice.record.id || invoice.record.number,
      invoiceRecord,
      invoice.row,
      now,
    );
    invoice = { record: write.value, row: invoice.row };
    writes.push(write.statement);
  }
  if (order) {
    const orderRecord = {
      ...order.record,
      paidAmount: summary.paid,
      balanceDue: summary.balance,
      paymentStatus: summary.status,
    };
    const write = entityWriteStatement(env, context, "orders", order.record.id, orderRecord, order.row, now);
    order = { record: write.value, row: order.row };
    writes.push(write.statement);
  }
  await env.DB.batch(writes);
  return {
    payment: paymentWrite.value,
    invoice: invoice?.record || null,
    workOrder: order?.record || null,
    summary,
  };
}
