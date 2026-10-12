import { HttpError } from "./http.mjs";

const READER_ID = /^tmr_[A-Za-z0-9]+$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/;

export function dollarsToCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (cents < 50 || cents > 99_999_999) return null;
  if (Math.abs(cents / 100 - value) > 0.001) return null;
  return cents;
}

export function cardPresentPaymentIntentBody({
  amountCents,
  shopId,
  targetType,
  targetId,
  customer = "",
  vehicle = "",
}) {
  const params = new URLSearchParams();
  params.set("currency", "usd");
  params.set("amount", String(amountCents));
  params.append("allowed_payment_method_types[]", "card_present");
  params.set("capture_method", "automatic");
  params.set("metadata[shopId]", String(shopId));
  params.set("metadata[source]", "terminal");
  params.set("metadata[targetType]", String(targetType));
  params.set("metadata[targetId]", String(targetId));
  params.set("metadata[customer]", String(customer).replace(/\s+/g, " ").trim().slice(0, 450));
  params.set("metadata[vehicle]", String(vehicle).replace(/\s+/g, " ").trim().slice(0, 450));
  return params;
}

export function assertStripeId(value, pattern, label) {
  const id = String(value || "").trim();
  if (!pattern.test(id)) throw new HttpError(400, `${label} is not a Stripe id`);
  return id;
}

export function publicReader(reader) {
  if (!reader?.id) return null;
  return {
    id: reader.id,
    label: reader.label || reader.id,
    status: reader.status || "unknown",
    deviceType: reader.device_type || "",
  };
}

export function terminalChargeState({ reader, paymentIntent }) {
  const action = reader?.action;
  if (paymentIntent?.status === "succeeded") {
    return { phase: "paid", message: "Card payment approved." };
  }
  if (action?.status === "in_progress") {
    return { phase: "waiting", message: "Ask the customer to tap, insert, or swipe the card on the reader." };
  }
  if (action?.status === "failed" || paymentIntent?.status === "requires_payment_method") {
    return {
      phase: "declined",
      message: action?.failure_message || "The card was not approved. Use the same charge and try the card again.",
    };
  }
  if (paymentIntent?.status === "canceled") {
    return { phase: "canceled", message: "The card charge was canceled." };
  }
  return { phase: "waiting", message: "Waiting on the card reader." };
}

const PHONE_NOTES = {
  terminal: "Stripe Terminal card payment",
  phone: "Phone card payment",
};

export function stripeKeyMode(key) {
  return /^(?:sk|pk)_(test|live)_/.exec(String(key || ""))?.[1] || "";
}

export function phonePaymentIntentBody({
  amountCents,
  shopId,
  targetType,
  targetId,
  customer = "",
  vehicle = "",
  moto = true,
}) {
  const params = new URLSearchParams();
  params.set("currency", "usd");
  params.set("amount", String(amountCents));
  params.append("allowed_payment_method_types[]", "card");
  params.set("capture_method", "automatic");
  if (moto) params.set("payment_method_options[card][moto]", "true");
  params.set("metadata[shopId]", String(shopId));
  params.set("metadata[source]", "phone");
  params.set("metadata[targetType]", String(targetType));
  params.set("metadata[targetId]", String(targetId));
  params.set("metadata[customer]", String(customer).replace(/\s+/g, " ").trim().slice(0, 450));
  params.set("metadata[vehicle]", String(vehicle).replace(/\s+/g, " ").trim().slice(0, 450));
  return params;
}

export function rejectRawCardFields(body) {
  const raw = JSON.stringify(body ?? {});
  if (/"[^"]*(?:card|cvc|cvv|pan|expir)[^"]*"\s*:/i.test(raw) || /\b(?:\d[ -]?){13,19}\b/.test(raw)) {
    throw new HttpError(400, "Card numbers stay in the secure card form. Do not send them to MechPro.");
  }
}

export function phoneChargeState(paymentIntent) {
  if (paymentIntent?.status === "succeeded") return { phase: "paid", message: "Phone card payment approved." };
  if (paymentIntent?.status === "processing") return { phase: "waiting", message: "The card is processing." };
  if (paymentIntent?.status === "requires_action") return { phase: "waiting", message: "The card needs an extra approval before it can be charged." };
  if (paymentIntent?.status === "canceled") return { phase: "canceled", message: "The phone charge was canceled." };
  if (paymentIntent?.status === "requires_payment_method") return { phase: "ready", message: "Enter the card number, expiration, security code, and postal code." };
  return { phase: "waiting", message: "Waiting on the card payment." };
}

export function terminalPaymentRecord(intent, shopId) {
  if (!intent || intent.object !== "payment_intent" || intent.status !== "succeeded") return null;
  const meta = intent.metadata || {};
  const note = PHONE_NOTES[meta.source];
  if (!note || meta.shopId !== shopId || intent.currency !== "usd") return null;
  if (!["invoice", "work_order"].includes(meta.targetType) || !meta.targetId) return null;
  const amount = Number(intent.amount_received ?? intent.amount ?? 0) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    paymentId: intent.id,
    body: {
      targetType: meta.targetType,
      targetId: meta.targetId,
      amount,
      method: "card",
      receivedAt: new Date().toISOString(),
      reference: intent.id,
      note,
    },
  };
}

async function stripeRequest(stripeKey, path, { method = "GET", params, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${stripeKey}:`)}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: params ? params.toString() : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, String(result.error?.message || "Stripe rejected the card terminal request").slice(0, 240));
  }
  return result;
}

export async function handleTerminalRoutes(request, env, context, deps) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  deps.requireRole(context, ["admin", "office", "service_writer"]);
  const stripeKey = await deps.getStripeKey(env, context.shopId);
  if (path === "/payments/terminal/readers" && request.method === "GET") {
    if (!stripeKey) return deps.json({ configured: false, readers: [], phoneEntry: false });
    const [listed, publishableKey] = await Promise.all([
      stripeRequest(stripeKey, "terminal/readers?limit=100", { fetchImpl: deps.fetchImpl }),
      deps.getPublishableKey(env, context.shopId),
    ]);
    return deps.json({
      configured: true,
      phoneEntry: Boolean(publishableKey),
      readers: (listed.data || []).map(publicReader).filter(Boolean),
    });
  }
  if (!stripeKey) throw new HttpError(409, "This shop has not connected a Stripe account yet");
  if (path === "/payments/terminal/charge" && request.method === "POST") {
    const body = await deps.requestJson(request);
    const readerId = assertStripeId(body.readerId, READER_ID, "Reader");
    const cents = dollarsToCents(body.amount);
    if (!cents) throw new HttpError(400, "Enter a card amount of at least $0.50");
    const snapshot = await deps.chargeTargetSnapshot(env, context, String(body.targetType || ""), String(body.targetId || ""));
    if (cents > Math.round(snapshot.before.balance * 100)) {
      throw new HttpError(409, "Payment amount exceeds the remaining balance");
    }
    let paymentIntentId = String(body.paymentIntentId || "").trim();
    if (paymentIntentId) {
      paymentIntentId = assertStripeId(paymentIntentId, PAYMENT_INTENT_ID, "Payment");
      const existing = await stripeRequest(stripeKey, `payment_intents/${paymentIntentId}`, { fetchImpl: deps.fetchImpl });
      if (existing.metadata?.shopId !== context.shopId || existing.metadata?.source !== "terminal") {
        throw new HttpError(404, "Card charge not found");
      }
      if (existing.status === "succeeded") {
        return deps.json({ paymentIntentId, readerId, ...terminalChargeState({ paymentIntent: existing }) });
      }
    } else {
      const created = await stripeRequest(stripeKey, "payment_intents", {
        method: "POST",
        fetchImpl: deps.fetchImpl,
        params: cardPresentPaymentIntentBody({
          amountCents: cents,
          shopId: context.shopId,
          targetType: body.targetType,
          targetId: body.targetId,
          customer: snapshot.customer,
          vehicle: snapshot.vehicle,
        }),
      });
      paymentIntentId = created.id;
    }
    const reader = await stripeRequest(stripeKey, `terminal/readers/${readerId}/process_payment_intent`, {
      method: "POST",
      fetchImpl: deps.fetchImpl,
      params: new URLSearchParams({ payment_intent: paymentIntentId }),
    });
    return deps.json({
      paymentIntentId,
      readerId,
      reader: publicReader(reader),
      ...terminalChargeState({ reader }),
    });
  }
  if (path === "/payments/terminal/status" && request.method === "GET") {
    const paymentIntentId = assertStripeId(url.searchParams.get("paymentIntentId"), PAYMENT_INTENT_ID, "Payment");
    const readerId = assertStripeId(url.searchParams.get("readerId"), READER_ID, "Reader");
    const [paymentIntent, reader] = await Promise.all([
      stripeRequest(stripeKey, `payment_intents/${paymentIntentId}`, { fetchImpl: deps.fetchImpl }),
      stripeRequest(stripeKey, `terminal/readers/${readerId}`, { fetchImpl: deps.fetchImpl }),
    ]);
    if (paymentIntent.metadata?.shopId !== context.shopId) throw new HttpError(404, "Card charge not found");
    const state = terminalChargeState({ reader, paymentIntent });
    let payment = null;
    if (state.phase === "paid") {
      const record = terminalPaymentRecord(paymentIntent, context.shopId);
      if (record) {
        try {
          payment = (await deps.recordPayment(env, context, record.body, { paymentId: record.paymentId })).payment;
        } catch (error) {
          if (error?.status !== 409) throw error;
          payment = { id: record.paymentId, status: "completed" };
        }
      }
    }
    return deps.json({ paymentIntentId, readerId, reader: publicReader(reader), ...state, payment });
  }
  if (path === "/payments/terminal/phone" && request.method === "POST") {
    const body = await deps.requestJson(request);
    rejectRawCardFields(body);
    const publishableKey = await deps.getPublishableKey(env, context.shopId);
    if (!publishableKey) throw new HttpError(409, "Add the Stripe publishable key on the Payments page before taking a phone card");
    if (stripeKeyMode(stripeKey) !== stripeKeyMode(publishableKey)) {
      throw new HttpError(409, "The publishable key does not match the saved Stripe secret key");
    }
    const cents = dollarsToCents(body.amount);
    if (!cents) throw new HttpError(400, "Enter a card amount of at least $0.50");
    const snapshot = await deps.chargeTargetSnapshot(env, context, String(body.targetType || ""), String(body.targetId || ""));
    if (cents > Math.round(snapshot.before.balance * 100)) {
      throw new HttpError(409, "Payment amount exceeds the remaining balance");
    }
    const intentFields = {
      amountCents: cents,
      shopId: context.shopId,
      targetType: body.targetType,
      targetId: body.targetId,
      customer: snapshot.customer,
      vehicle: snapshot.vehicle,
    };
    let created;
    let moto = true;
    try {
      created = await stripeRequest(stripeKey, "payment_intents", {
        method: "POST",
        fetchImpl: deps.fetchImpl,
        params: phonePaymentIntentBody({ ...intentFields, moto: true }),
      });
    } catch (error) {
      if (!/moto/i.test(error.message || "")) throw error;
      moto = false;
      created = await stripeRequest(stripeKey, "payment_intents", {
        method: "POST",
        fetchImpl: deps.fetchImpl,
        params: phonePaymentIntentBody({ ...intentFields, moto: false }),
      });
    }
    return deps.json({
      paymentIntentId: created.id,
      clientSecret: created.client_secret,
      publishableKey,
      moto,
    });
  }
  if (path === "/payments/terminal/phone/status" && request.method === "GET") {
    const paymentIntentId = assertStripeId(url.searchParams.get("paymentIntentId"), PAYMENT_INTENT_ID, "Payment");
    const paymentIntent = await stripeRequest(stripeKey, `payment_intents/${paymentIntentId}`, { fetchImpl: deps.fetchImpl });
    if (paymentIntent.metadata?.shopId !== context.shopId || paymentIntent.metadata?.source !== "phone") {
      throw new HttpError(404, "Phone charge not found");
    }
    const state = phoneChargeState(paymentIntent);
    let payment = null;
    if (state.phase === "paid") {
      const record = terminalPaymentRecord(paymentIntent, context.shopId);
      if (record) {
        try {
          payment = (await deps.recordPayment(env, context, record.body, { paymentId: record.paymentId })).payment;
        } catch (error) {
          if (error?.status !== 409) throw error;
          payment = { id: record.paymentId, status: "completed" };
        }
      }
    }
    return deps.json({ paymentIntentId, ...state, payment });
  }
  if (path === "/payments/terminal/cancel" && request.method === "POST") {
    const body = await deps.requestJson(request);
    const readerId = assertStripeId(body.readerId, READER_ID, "Reader");
    const reader = await stripeRequest(stripeKey, `terminal/readers/${readerId}/cancel_action`, {
      method: "POST",
      fetchImpl: deps.fetchImpl,
    });
    return deps.json({ reader: publicReader(reader), phase: "canceled", message: "The reader was cleared." });
  }
  throw new HttpError(405, "Method not allowed");
}
