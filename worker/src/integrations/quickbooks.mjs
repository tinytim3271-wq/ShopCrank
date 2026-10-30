import {
  QboTaxConfigError,
  applyQboInvoiceTax,
  qboBillableLines,
  qboLineMoney,
  qboLineTaxable,
  qboTaxModeFromCompany,
  resolveQboTaxSettings,
} from "../../../src/modules/quickbooks.js";

const AUTHORIZATION_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API_BASE_URLS = Object.freeze({
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
});
const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;

export class QuickBooksError extends Error {
  constructor(message, { code = "QUICKBOOKS_ERROR", status = 0 } = {}) {
    super(message);
    this.name = "QuickBooksError";
    this.code = code;
    this.status = status;
  }
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new QuickBooksError(`${name} is required`, { code: "INVALID_INPUT" });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new QuickBooksError(`${name} exceeds ${maxLength} characters`, {
      code: "INVALID_INPUT",
    });
  }
  return normalized;
}

function optionalString(value, name, maxLength) {
  if (value == null || value === "") return undefined;
  return requiredString(value, name, maxLength);
}

function boundedNumber(value, name, { min = 0, max = 999_999_999_999 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new QuickBooksError(`${name} must be a number between ${min} and ${max}`, {
      code: "INVALID_INPUT",
    });
  }
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function isoDate(value, name) {
  if (value == null || value === "") return undefined;
  const date = requiredString(value, name, 10);
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new QuickBooksError(`${name} must be an ISO date (YYYY-MM-DD)`, {
      code: "INVALID_INPUT",
    });
  }
  return date;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function resolveConfig(env = {}) {
  const environment = env.INTUIT_ENVIRONMENT || "production";
  if (!Object.hasOwn(API_BASE_URLS, environment)) {
    throw new QuickBooksError("INTUIT_ENVIRONMENT must be sandbox or production", {
      code: "QUICKBOOKS_UNCONFIGURED",
    });
  }
  return {
    clientId: requiredString(env.INTUIT_CLIENT_ID, "INTUIT_CLIENT_ID", 255),
    clientSecret: requiredString(env.INTUIT_CLIENT_SECRET, "INTUIT_CLIENT_SECRET", 1024),
    redirectUri: requiredString(env.INTUIT_REDIRECT_URI, "INTUIT_REDIRECT_URI", 2048),
    environment,
    apiBaseUrl: API_BASE_URLS[environment],
  };
}

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new QuickBooksError(`${name} callback is required`, {
      code: "QUICKBOOKS_UNCONFIGURED",
    });
  }
  return value;
}

function randomBase64Url(cryptoImpl, byteLength) {
  const bytes = new Uint8Array(byteLength);
  cryptoImpl.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Base64Url(cryptoImpl, value) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function basicAuthorization(clientId, clientSecret) {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function apiError(data, status) {
  const error = data?.Fault?.Error?.[0] || {};
  const detail = error.Detail || error.Message;
  const safeDetail = typeof detail === "string" ? detail.slice(0, 500) : "";
  const faultCode = typeof error.code === "string" ? error.code.slice(0, 10) : "";
  const taxRelated = /tax|gst|hst|vat/i.test(safeDetail);
  let message = safeDetail ? `QuickBooks request failed: ${safeDetail}` : `QuickBooks request failed (${status})`;
  if (faultCode) message = `QuickBooks error ${faultCode}: ${safeDetail || `request failed (${status})`}`;
  if (faultCode === "6000" && taxRelated) {
    message += " Check the QuickBooks tax settings in Shop Crank (Integrations → QuickBooks) and that sales tax is set up in QuickBooks.";
  }
  const result = new QuickBooksError(message, { code: "QUICKBOOKS_API_ERROR", status });
  result.faultCode = faultCode || null;
  return result;
}

function tokenMetadata(tokens) {
  return compact({
    realmId: tokens.realmId,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    scope: tokens.scope,
  });
}

function normalizeTokenResponse(data, previous, realmId, now) {
  const accessToken = requiredString(data?.access_token, "QuickBooks access token", 8192);
  const refreshToken =
    optionalString(data?.refresh_token, "QuickBooks refresh token", 8192) ||
    previous?.refreshToken;
  if (!refreshToken) {
    throw new QuickBooksError("QuickBooks did not provide a refresh token", {
      code: "QUICKBOOKS_TOKEN_ERROR",
    });
  }
  return {
    accessToken,
    refreshToken,
    tokenType: optionalString(data.token_type, "QuickBooks token type", 50) || "bearer",
    scope: optionalString(data.scope, "QuickBooks scope", 1000) || previous?.scope,
    expiresAt: now + boundedNumber(data.expires_in ?? 3600, "expires_in", { min: 1 }) * 1000,
    refreshExpiresAt:
      data.x_refresh_token_expires_in == null
        ? previous?.refreshExpiresAt
        : now +
          boundedNumber(data.x_refresh_token_expires_in, "x_refresh_token_expires_in", {
            min: 1,
          }) *
            1000,
    realmId: requiredString(realmId || previous?.realmId, "QuickBooks realmId", 255),
  };
}

function callbackValues(callback) {
  if (callback instanceof URL || typeof callback === "string") {
    const url = callback instanceof URL ? callback : new URL(callback);
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      realmId: url.searchParams.get("realmId"),
      error: url.searchParams.get("error"),
    };
  }
  if (!callback || typeof callback !== "object") {
    throw new QuickBooksError("OAuth callback parameters are required", {
      code: "INVALID_INPUT",
    });
  }
  return callback;
}

export function normalizeQuickBooksCustomer(customer) {
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    throw new QuickBooksError("customer must be an object", { code: "INVALID_INPUT" });
  }
  const displayName = requiredString(
    customer.displayName || customer.name || customer.companyName,
    "customer.displayName",
    500,
  );
  const address = customer.billingAddress || customer.address;
  const payload = compact({
    DisplayName: displayName,
    GivenName: optionalString(customer.givenName || customer.firstName, "customer.givenName", 100),
    FamilyName: optionalString(customer.familyName || customer.lastName, "customer.familyName", 100),
    CompanyName: optionalString(customer.companyName, "customer.companyName", 500),
    PrimaryEmailAddr: customer.email
      ? { Address: requiredString(customer.email, "customer.email", 100) }
      : undefined,
    PrimaryPhone: customer.phone
      ? { FreeFormNumber: requiredString(customer.phone, "customer.phone", 30) }
      : undefined,
    BillAddr: address
      ? compact({
          Line1: optionalString(address.line1, "customer.billingAddress.line1", 500),
          Line2: optionalString(address.line2, "customer.billingAddress.line2", 500),
          City: optionalString(address.city, "customer.billingAddress.city", 255),
          CountrySubDivisionCode: optionalString(
            address.region || address.state,
            "customer.billingAddress.region",
            255,
          ),
          PostalCode: optionalString(address.postalCode, "customer.billingAddress.postalCode", 30),
          Country: optionalString(address.country, "customer.billingAddress.country", 255),
        })
      : undefined,
  });
  if (payload.BillAddr && Object.keys(payload.BillAddr).length === 0) delete payload.BillAddr;
  return payload;
}

function salesLine(line, index, label = `invoice.lines[${index}]`) {
  if (!line || typeof line !== "object") {
    throw new QuickBooksError(`${label} must be an object`, { code: "INVALID_INPUT" });
  }
  const money = qboLineMoney(line);
  const quantity = boundedNumber(money.qty, `${label}.quantity`);
  const unitPrice = boundedNumber(money.unitPrice, `${label}.unitPrice`);
  const amount = boundedNumber(money.amount, `${label}.amount`);
  return compact({
    Amount: amount,
    DetailType: "SalesItemLineDetail",
    Description: optionalString(line.description, `${label}.description`, 4000),
    SalesItemLineDetail: compact({
      ItemRef: line.quickBooksItemId
        ? { value: requiredString(line.quickBooksItemId, `${label}.quickBooksItemId`, 255) }
        : undefined,
      Qty: quantity,
      UnitPrice: unitPrice,
    }),
  });
}

/**
 * `options.tax` is the company tax context ({ mode, taxCodeId, exemptTaxCodeId }).
 * When the invoice carries a `subtotal`, QBO lines are reconciled to it so fees
 * and discounts applied in Shop Crank are not lost.
 */
export function normalizeQuickBooksInvoice(invoice, { tax = null, defaultItemId = "" } = {}) {
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) {
    throw new QuickBooksError("invoice must be an object", { code: "INVALID_INPUT" });
  }
  const customerId = requiredString(
    invoice.quickBooksCustomerId || invoice.customerId,
    "invoice.quickBooksCustomerId",
    255,
  );
  const billable = Array.isArray(invoice.lines) ? qboBillableLines(invoice.lines) : [];
  if (billable.length === 0 || billable.length > 1000) {
    throw new QuickBooksError("invoice.lines must contain 1 to 1000 billable lines", {
      code: "INVALID_INPUT",
    });
  }
  const fees = (Array.isArray(invoice.fees) ? invoice.fees : [])
    .filter((fee) => Number(fee?.amount) > 0)
    .map((fee) => ({ description: fee.description || "Fee", quantity: 1, unitPrice: fee.amount, amount: fee.amount, taxable: fee.taxable, quickBooksItemId: fee.quickBooksItemId || defaultItemId || undefined }));
  const sourceLines = [...billable, ...fees];
  const lines = sourceLines.map((line, index) => salesLine(line, index));
  const totalTax = Number(invoice.tax) || 0;
  const taxable = sourceLines.map((line) => qboLineTaxable(line, totalTax));

  const lineSum = Math.round(lines.reduce((sum, line) => sum + line.Amount, 0) * 100) / 100;
  const subtotal = invoice.subtotal === undefined || invoice.subtotal === null || invoice.subtotal === ""
    ? null
    : boundedNumber(invoice.subtotal, "invoice.subtotal");
  if (subtotal !== null && Math.abs(subtotal - lineSum) >= 0.01) {
    const difference = Math.round((subtotal - lineSum) * 100) / 100;
    if (difference < 0) {
      lines.push({ Amount: -difference, DetailType: "DiscountLineDetail", Description: invoice.discountReason || "Discount", DiscountLineDetail: { PercentBased: false } });
    } else {
      lines.push(salesLine({ description: "Shop fees and supplies", quantity: 1, unitPrice: difference, amount: difference, quickBooksItemId: defaultItemId || undefined }, lines.length, "invoice.reconciliation"));
      taxable.push(totalTax > 0);
    }
  }

  const payload = compact({
    CustomerRef: { value: customerId },
    DocNumber: optionalString(invoice.number || invoice.docNumber, "invoice.number", 21),
    TxnDate: isoDate(invoice.date || invoice.txnDate, "invoice.date"),
    DueDate: isoDate(invoice.dueDate, "invoice.dueDate"),
    PrivateNote: optionalString(invoice.note, "invoice.note", 4000),
    Line: lines,
  });
  try {
    return applyQboInvoiceTax(payload, { taxable, totalTax, tax });
  } catch (error) {
    if (error instanceof QboTaxConfigError) throw new QuickBooksError(error.message, { code: error.code, status: 409 });
    throw error;
  }
}

export function normalizeQuickBooksPayment(payment) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
    throw new QuickBooksError("payment must be an object", { code: "INVALID_INPUT" });
  }
  const invoiceId = optionalString(
    payment.quickBooksInvoiceId || payment.invoiceId,
    "payment.quickBooksInvoiceId",
    255,
  );
  return compact({
    CustomerRef: {
      value: requiredString(
        payment.quickBooksCustomerId || payment.customerId,
        "payment.quickBooksCustomerId",
        255,
      ),
    },
    TotalAmt: boundedNumber(payment.amount ?? payment.totalAmount, "payment.amount"),
    TxnDate: isoDate(payment.date || payment.txnDate, "payment.date"),
    PaymentRefNum: optionalString(payment.reference || payment.paymentRefNum, "payment.reference", 21),
    PrivateNote: optionalString(payment.note, "payment.note", 4000),
    Line: invoiceId
      ? [
          {
            Amount: boundedNumber(payment.amount ?? payment.totalAmount, "payment.amount"),
            LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
          },
        ]
      : undefined,
  });
}

export function createQuickBooksIntegration({
  env = {},
  fetch: fetchImpl = globalThis.fetch,
  crypto: cryptoImpl = globalThis.crypto,
  loadTokens,
  saveTokens,
  saveState,
  loadState,
  deleteState,
  saveSyncMetadata,
  now = () => Date.now(),
  stateTtlMs = DEFAULT_STATE_TTL_MS,
} = {}) {
  async function tokenRequest(parameters, previous, realmId) {
    const config = resolveConfig(env);
    assertFunction(fetchImpl, "fetch");
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: basicAuthorization(config.clientId, config.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new QuickBooksError(`QuickBooks token request failed (${response.status})`, {
        code: "QUICKBOOKS_TOKEN_ERROR",
        status: response.status,
      });
    }
    const tokens = normalizeTokenResponse(data, previous, realmId, now());
    await assertFunction(saveTokens, "saveTokens")({ ...tokens });
    return tokens;
  }

  async function getAuthorizationUrl({ state: suppliedState } = {}) {
    const config = resolveConfig(env);
    const persistState = assertFunction(saveState, "saveState");
    if (
      !cryptoImpl ||
      typeof cryptoImpl.getRandomValues !== "function" ||
      typeof cryptoImpl.subtle?.digest !== "function"
    ) {
      throw new QuickBooksError("Web Crypto is required for OAuth state and PKCE", {
        code: "QUICKBOOKS_UNCONFIGURED",
      });
    }
    const state = suppliedState
      ? requiredString(suppliedState, "state", 512)
      : randomBase64Url(cryptoImpl, 32);
    const codeVerifier = randomBase64Url(cryptoImpl, 64);
    const codeChallenge = await sha256Base64Url(cryptoImpl, codeVerifier);
    await persistState(state, {
      codeVerifier,
      createdAt: now(),
      redirectUri: config.redirectUri,
    });
    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      scope: ACCOUNTING_SCOPE,
      redirect_uri: config.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.toString(), state };
  }

  async function exchangeCallback(callback) {
    const config = resolveConfig(env);
    const values = callbackValues(callback);
    if (values.error) {
      throw new QuickBooksError("QuickBooks authorization was denied", {
        code: "QUICKBOOKS_AUTH_DENIED",
      });
    }
    const state = requiredString(values.state, "OAuth state", 512);
    const persisted = await assertFunction(loadState, "loadState")(state);
    if (
      !persisted ||
      typeof persisted !== "object" ||
      !Number.isFinite(persisted.createdAt) ||
      now() - persisted.createdAt < 0 ||
      now() - persisted.createdAt > stateTtlMs
    ) {
      throw new QuickBooksError("OAuth state is invalid or expired", {
        code: "QUICKBOOKS_INVALID_STATE",
      });
    }
    if (persisted.redirectUri && persisted.redirectUri !== config.redirectUri) {
      throw new QuickBooksError("OAuth redirect URI does not match the saved state", {
        code: "QUICKBOOKS_INVALID_STATE",
      });
    }
    if (deleteState) await deleteState(state);
    const parameters = {
      grant_type: "authorization_code",
      code: requiredString(values.code, "authorization code", 4096),
      redirect_uri: config.redirectUri,
    };
    if (persisted.codeVerifier) {
      parameters.code_verifier = requiredString(persisted.codeVerifier, "PKCE verifier", 512);
    }
    const tokens = await tokenRequest(
      parameters,
      undefined,
      requiredString(values.realmId, "QuickBooks realmId", 255),
    );
    return tokenMetadata(tokens);
  }

  async function refreshTokens(existingTokens) {
    const existing =
      existingTokens || (await assertFunction(loadTokens, "loadTokens")());
    if (!existing || typeof existing !== "object") {
      throw new QuickBooksError("QuickBooks is not connected", {
        code: "QUICKBOOKS_NOT_CONNECTED",
      });
    }
    const refreshToken = requiredString(
      existing.refreshToken,
      "stored QuickBooks refresh token",
      8192,
    );
    const tokens = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      existing,
      existing.realmId,
    );
    return tokenMetadata(tokens);
  }

  async function usableTokens(forceRefresh = false) {
    const existing = await assertFunction(loadTokens, "loadTokens")();
    if (!existing || typeof existing !== "object") {
      throw new QuickBooksError("QuickBooks is not connected", {
        code: "QUICKBOOKS_NOT_CONNECTED",
      });
    }
    if (
      forceRefresh ||
      !existing.accessToken ||
      !Number.isFinite(existing.expiresAt) ||
      existing.expiresAt <= now() + EXPIRY_SKEW_MS
    ) {
      await refreshTokens(existing);
      const refreshed = await loadTokens();
      if (!refreshed?.accessToken) {
        throw new QuickBooksError("Saved QuickBooks tokens could not be loaded", {
          code: "QUICKBOOKS_TOKEN_ERROR",
        });
      }
      return refreshed;
    }
    return existing;
  }

  async function qboRequest(method, resourcePath, payload, params = {}) {
    const config = resolveConfig(env);
    assertFunction(fetchImpl, "fetch");
    let tokens = await usableTokens();
    const request = async () => {
      const realmId = requiredString(tokens.realmId, "stored QuickBooks realmId", 255);
      const url = new URL(
        `/v3/company/${encodeURIComponent(realmId)}/${resourcePath.replaceAll("{realmId}", encodeURIComponent(realmId))}`,
        config.apiBaseUrl,
      );
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      url.searchParams.set("minorversion", "75");
      return fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${requiredString(tokens.accessToken, "stored access token", 8192)}`,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    };
    const retryable = method === "GET" || Boolean(params.requestid);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await request();
      } catch (error) {
        if (!retryable || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      if (response.status === 401) break;
      if (!retryable || ![429, 500, 502, 503, 504].includes(response.status) || attempt >= 2) break;
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(2_000, retryAfter * 1_000)
        : 200 * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    if (response.status === 401) {
      await refreshTokens(tokens);
      tokens = await loadTokens();
      response = await request();
    }
    const data = await readJson(response);
    if (!response.ok) throw apiError(data, response.status);
    return { data, realmId: tokens.realmId };
  }

  async function getTaxContext(saved = {}) {
    // Sequential: an expired token must be refreshed once, not by parallel calls.
    const { data: preferences } = await qboRequest("GET", "preferences");
    const { data: companyInfo } = await qboRequest("GET", "companyinfo/{realmId}");
    const { data: codes } = await qboRequest("GET", "query", undefined, {
      query: "select * from TaxCode where Active = true maxresults 200",
    });
    const mode = qboTaxModeFromCompany({ preferences, companyInfo });
    const taxCodes = codes?.QueryResponse?.TaxCode || [];
    return {
      ...resolveQboTaxSettings(mode, taxCodes, saved),
      country: companyInfo?.CompanyInfo?.Country || null,
      taxCodes: taxCodes.map((code) => ({
        id: String(code.Id),
        name: String(code.Name || code.Id),
        taxable: code.Taxable !== false,
      })),
    };
  }

  async function syncInvoiceWithTax(invoice, { taxSettings = {}, defaultItemId = "", remoteId = "" } = {}) {
    const tax = await getTaxContext(taxSettings);
    const result = await sync(
      "Invoice",
      invoice?.id,
      normalizeQuickBooksInvoice(invoice, { tax, defaultItemId }),
      "Invoice",
      { remoteId },
    );
    const expectedTax = Math.round((Number(invoice?.tax) || 0) * 100) / 100;
    const remoteTax = Number(result.entity?.TxnTaxDetail?.TotalTax);
    return {
      ...result,
      tax: {
        mode: tax.mode,
        expected: expectedTax,
        quickBooks: Number.isFinite(remoteTax) ? remoteTax : null,
        mismatch: Number.isFinite(remoteTax) && Math.abs(remoteTax - expectedTax) >= 0.01,
      },
    };
  }

  async function sync(type, localId, payload, responseKey, { remoteId = "" } = {}) {
    let requestPayload = payload;
    if (remoteId) {
      const { data: current } = await qboRequest("GET", `${type.toLowerCase()}/${encodeURIComponent(remoteId)}`);
      const existing = current?.[responseKey];
      if (!existing || String(existing.Id || "") !== String(remoteId) || !existing.SyncToken) {
        throw new QuickBooksError(`QuickBooks ${type} ${remoteId} could not be loaded for update`, {
          code: "QUICKBOOKS_SYNC_CONFLICT",
          status: 409,
        });
      }
      requestPayload = { ...payload, Id: String(existing.Id), SyncToken: String(existing.SyncToken) };
    }
    const requestId = (await sha256Base64Url(
      cryptoImpl,
      `${responseKey}|${localId}|${remoteId}|${JSON.stringify(requestPayload)}`,
    )).slice(0, 40);
    const { data, realmId } = await qboRequest(
      "POST",
      type.toLowerCase(),
      requestPayload,
      { requestid: requestId },
    );
    const remote = data?.[responseKey];
    const quickBooksId = requiredString(remote?.Id, `QuickBooks ${type} ID`, 255);
    const metadata = {
      provider: "quickbooks",
      entityType: type.toLowerCase(),
      localId: optionalString(localId, "localId", 255),
      quickBooksId,
      realmId,
      syncedAt: new Date(now()).toISOString(),
    };
    if (saveSyncMetadata) await saveSyncMetadata({ ...metadata });
    return { entity: remote, syncMetadata: metadata };
  }

  return Object.freeze({
    getAuthorizationUrl,
    exchangeCallback,
    refreshTokens,
    syncCustomer: (customer, options = {}) =>
      sync("Customer", customer?.id, normalizeQuickBooksCustomer(customer), "Customer", options),
    syncInvoice: (invoice, options = {}) =>
      sync("Invoice", invoice?.id, normalizeQuickBooksInvoice(invoice), "Invoice", options),
    getTaxContext,
    syncInvoiceWithTax,
    syncPayment: (payment, options = {}) =>
      sync("Payment", payment?.id, normalizeQuickBooksPayment(payment), "Payment", options),
  });
}

export const QUICKBOOKS_ENDPOINTS = Object.freeze({
  authorization: AUTHORIZATION_URL,
  token: TOKEN_URL,
  ...API_BASE_URLS,
});
import {
  QUICKBOOKS_SECRET_NAME,
  QUICKBOOKS_SCOPES,
  buildQboIdempotencyKey,
  mapCustomerToQbo,
  mapInvoiceToQbo,
  mapPaymentToQbo,
  quickbooksConnectionStatus,
} from '../../../src/modules/quickbooks.js';
import { HttpError, json, requestJson } from '../http.mjs';

const ADMIN_ROLES = ['owner', 'admin', 'super_admin'];
const USE_ROLES = ['owner', 'admin', 'service_writer', 'office'];
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com/v3/company';

function appCredentials(env) {
  const clientId = String(env.QUICKBOOKS_CLIENT_ID || '').trim();
  const clientSecret = String(env.QUICKBOOKS_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new HttpError(503, 'QuickBooks Online app credentials are not configured on the Worker');
  }
  return { clientId, clientSecret };
}

function apiBase(env, record) {
  if (record?.environment === 'sandbox' || env.QUICKBOOKS_SANDBOX === '1') return SANDBOX_API_BASE;
  return env.QUICKBOOKS_API_BASE || API_BASE;
}

async function readRecord(getSecret, shopId) {
  const raw = await getSecret(shopId, QUICKBOOKS_SECRET_NAME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function exchangeToken(env, form, fetcher = fetch) {
  const { clientId, clientSecret } = appCredentials(env);
  const basic = btoa(`${clientId}:${clientSecret}`);
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new HttpError(502, body.error_description || body.error || 'QuickBooks token exchange failed');
  }
  return body;
}

async function ensureAccessToken(env, record, { getSecret, saveSecret, shopId, fetcher = fetch }) {
  if (!quickbooksConnectionStatus(record).connected) {
    throw new HttpError(409, 'QuickBooks Online is not connected');
  }
  const expiresAt = Date.parse(record.tokenExpiresAt || 0);
  if (record.accessToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
    return record;
  }
  if (!record.refreshToken) throw new HttpError(409, 'QuickBooks Online needs to be reconnected');
  const token = await exchangeToken(env, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: record.refreshToken,
  }), fetcher);
  const next = {
    ...record,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || record.refreshToken,
    tokenExpiresAt: new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000).toISOString(),
    refreshExpiresAt: token.x_refresh_token_expires_in
      ? new Date(Date.now() + Number(token.x_refresh_token_expires_in) * 1000).toISOString()
      : record.refreshExpiresAt || null,
  };
  await saveSecret(env, shopId, QUICKBOOKS_SECRET_NAME, JSON.stringify(next));
  return next;
}

async function qboRequest(env, record, path, { method = 'GET', body, fetcher = fetch } = {}) {
  const response = await fetcher(`${apiBase(env, record)}/${encodeURIComponent(record.realmId)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${record.accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (payload?.Fault) throw new HttpError(502, apiError(payload, response.status).message);
    throw new HttpError(502, payload.message || `QuickBooks request failed (${response.status})`);
  }
  return payload;
}

async function detectTaxContext(env, record, fetcher, saved = {}) {
  const preferences = await qboRequest(env, record, '/preferences?minorversion=75', { fetcher });
  const companyInfo = await qboRequest(env, record, `/companyinfo/${encodeURIComponent(record.realmId)}?minorversion=75`, { fetcher });
  const query = encodeURIComponent('select * from TaxCode where Active = true maxresults 200');
  const codes = await qboRequest(env, record, `/query?query=${query}&minorversion=75`, { fetcher });
  return resolveQboTaxSettings(
    qboTaxModeFromCompany({ preferences, companyInfo }),
    codes?.QueryResponse?.TaxCode || [],
    saved,
  );
}

async function findSync(env, shopId, idempotencyKey) {
  return env.DB.prepare(
    'SELECT remote_id, status, payload_hash FROM integration_sync_log WHERE shop_id = ? AND provider = ? AND idempotency_key = ?',
  ).bind(shopId, 'quickbooks', idempotencyKey).first();
}

async function writeSync(env, {
  shopId, entityType, localId, remoteId, idempotencyKey, payloadHash, status, error = null,
}) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO integration_sync_log
      (shop_id, provider, entity_type, local_id, remote_id, idempotency_key, payload_hash, status, last_error, synced_at)
    VALUES (?, 'quickbooks', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, provider, idempotency_key) DO UPDATE SET
      remote_id = excluded.remote_id,
      payload_hash = excluded.payload_hash,
      status = excluded.status,
      last_error = excluded.last_error,
      synced_at = excluded.synced_at
  `).bind(shopId, entityType, localId, remoteId || '', idempotencyKey, payloadHash || '', status, error, now).run();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createQuickbooksHandlers({
  saveSecret,
  getSecret,
  deleteSecret,
  requireRole,
  recordAudit,
}) {
  return async function handleQuickbooks(request, env, context, segments) {
    const action = segments[2] || '';
    const fetcher = env.fetch || fetch;

    if (request.method === 'GET' && !action) {
      requireRole(context, USE_ROLES);
      return json(quickbooksConnectionStatus(await readRecord(getSecret, context.shopId)));
    }

    if (action === 'connect' && request.method === 'POST') {
      requireRole(context, ADMIN_ROLES);
      const { clientId } = appCredentials(env);
      const body = await requestJson(request).catch(() => ({}));
      const redirectUri = String(body.redirectUri || env.QUICKBOOKS_REDIRECT_URI || '').trim();
      if (!redirectUri) throw new HttpError(400, 'redirectUri is required');
      const state = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await env.DB.prepare(`
        INSERT INTO oauth_states (state, shop_id, provider, created_at, expires_at, meta_json)
        VALUES (?, ?, 'quickbooks', ?, ?, ?)
      `).bind(state, context.shopId, new Date().toISOString(), expiresAt, JSON.stringify({ redirectUri, userId: context.userId })).run();
      const url = new URL(AUTH_URL);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', QUICKBOOKS_SCOPES);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return json({ authorizeUrl: url.toString(), state });
    }

    if (action === 'callback' && request.method === 'POST') {
      // Authenticated shop callback after Intuit redirects to the app with ?code&realmId&state
      requireRole(context, ADMIN_ROLES);
      const body = await requestJson(request);
      const code = String(body.code || '').trim();
      const realmId = String(body.realmId || '').trim();
      const state = String(body.state || '').trim();
      if (!code || !realmId || !state) throw new HttpError(400, 'code, realmId, and state are required');
      const row = await env.DB.prepare(
        'SELECT shop_id, expires_at, meta_json FROM oauth_states WHERE state = ? AND provider = ?',
      ).bind(state, 'quickbooks').first();
      if (!row || row.shop_id !== context.shopId) throw new HttpError(400, 'Invalid OAuth state');
      if (Date.parse(row.expires_at) < Date.now()) throw new HttpError(400, 'OAuth state expired');
      const meta = JSON.parse(row.meta_json || '{}');
      const token = await exchangeToken(env, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: meta.redirectUri,
      }), fetcher);
      const record = {
        realmId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000).toISOString(),
        refreshExpiresAt: token.x_refresh_token_expires_in
          ? new Date(Date.now() + Number(token.x_refresh_token_expires_in) * 1000).toISOString()
          : null,
        connectedAt: new Date().toISOString(),
        connectedBy: context.userId,
        environment: env.QUICKBOOKS_SANDBOX === '1' ? 'sandbox' : 'production',
      };
      await saveSecret(env, context.shopId, QUICKBOOKS_SECRET_NAME, JSON.stringify(record));
      await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
      await recordAudit?.(env, context, { kind: 'integrations.quickbooks.connect', realmId });
      return json(quickbooksConnectionStatus(record), 201);
    }

    if (request.method === 'DELETE' && !action) {
      requireRole(context, ADMIN_ROLES);
      await deleteSecret(env, context.shopId, QUICKBOOKS_SECRET_NAME);
      await recordAudit?.(env, context, { kind: 'integrations.quickbooks.disconnect' });
      return json({ connected: false, status: 'not_connected' });
    }

    let record = await readRecord(getSecret, context.shopId);
    if (!quickbooksConnectionStatus(record).connected) {
      throw new HttpError(409, 'QuickBooks Online is not connected');
    }
    requireRole(context, USE_ROLES);
    record = await ensureAccessToken(env, record, {
      getSecret, saveSecret, shopId: context.shopId, fetcher,
    });

    if (action === 'sync' && request.method === 'POST') {
      const body = await requestJson(request);
      const entityType = String(body.entityType || '').toLowerCase();
      const localId = String(body.localId || body.id || '').trim();
      if (!['customer', 'invoice', 'payment'].includes(entityType)) {
        throw new HttpError(400, 'entityType must be customer, invoice, or payment');
      }
      if (!localId) throw new HttpError(400, 'localId is required');
      const idempotencyKey = buildQboIdempotencyKey(context.shopId, entityType, localId, body.action || 'upsert');
      let payload;
      if (entityType === 'customer') payload = mapCustomerToQbo(body.customer || body.data || {});
      else if (entityType === 'invoice') {
        const tax = await detectTaxContext(env, record, fetcher, record.taxSettings || {});
        try {
          payload = mapInvoiceToQbo(body.invoice || body.data || {}, body.customerRef || body.qboCustomerId, { tax });
        } catch (error) {
          if (error instanceof QboTaxConfigError) throw new HttpError(409, error.message);
          throw error;
        }
      } else {
        payload = mapPaymentToQbo(
          body.payment || body.data || {},
          body.customerRef || body.qboCustomerId,
          body.invoiceRef || body.qboInvoiceId,
        );
      }
      const payloadHash = await sha256Hex(JSON.stringify(payload));
      const existing = await findSync(env, context.shopId, idempotencyKey);
      if (existing?.status === 'synced' && existing.payload_hash === payloadHash && existing.remote_id) {
        return json({
          connected: true,
          idempotent: true,
          entityType,
          localId,
          remoteId: existing.remote_id,
        });
      }

      try {
        const resource = entityType === 'customer' ? 'customer' : entityType === 'invoice' ? 'invoice' : 'payment';
        const result = await qboRequest(env, record, `/${resource}?minorversion=75`, {
          method: 'POST',
          body: payload,
          fetcher,
        });
        const entity = result.Customer || result.Invoice || result.Payment || result;
        const remoteId = String(entity.Id || '');
        await writeSync(env, {
          shopId: context.shopId,
          entityType,
          localId,
          remoteId,
          idempotencyKey,
          payloadHash,
          status: 'synced',
        });
        await recordAudit?.(env, context, {
          kind: 'integrations.quickbooks.sync',
          entityType,
          localId,
          remoteId,
        });
        return json({
          connected: true,
          idempotent: false,
          entityType,
          localId,
          remoteId,
          syncToken: entity.SyncToken || null,
        });
      } catch (error) {
        await writeSync(env, {
          shopId: context.shopId,
          entityType,
          localId,
          remoteId: existing?.remote_id || '',
          idempotencyKey,
          payloadHash,
          status: 'error',
          error: error.message || 'sync failed',
        });
        throw error;
      }
    }

    throw new HttpError(404, 'Not found');
  };
}
