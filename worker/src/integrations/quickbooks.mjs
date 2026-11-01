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
    getCompanyInfo: async () => {
      const { data, realmId } = await qboRequest("GET", "companyinfo/{realmId}");
      return { realmId, companyName: data?.CompanyInfo?.CompanyName || "" };
    },
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

/** Where a shop's QuickBooks OAuth tokens live (same name the Integrations page connect flow writes). */
export const QUICKBOOKS_TOKEN_SECRET = 'quickbooks-oauth-tokens';

/** Dry-run check of a shop's stored QuickBooks tokens and the Worker's Intuit app config. */
export async function quickbooksConfigStatus(env, { shopId, getSecret }) {
  let tokens = null;
  try { tokens = JSON.parse((await getSecret(shopId, QUICKBOOKS_TOKEN_SECRET)) || 'null'); } catch { tokens = null; }
  if (!tokens?.realmId || !(tokens.refreshToken || tokens.accessToken)) {
    return { configured: false, reason: 'QuickBooks Online not connected' };
  }
  try {
    resolveConfig(env);
  } catch {
    return { configured: true, valid: false, reason: 'QuickBooks Online app credentials (INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET, INTUIT_REDIRECT_URI) are not configured on the Worker' };
  }
  if (!tokens.refreshToken && !(Number(tokens.expiresAt) > Date.now())) {
    return { configured: true, valid: false, reason: 'QuickBooks Online needs to be reconnected' };
  }
  return { configured: true, valid: true };
}

/**
 * Health-check ping: a shop's QuickBooks connection answers a CompanyInfo read.
 * Refreshes (and re-saves) an expired access token exactly like a sync would.
 * `getSecret(shopId, name)` / `saveSecret(env, shopId, name, value)`.
 */
export async function pingQuickbooks(env, { shopId, getSecret, saveSecret, fetcher = fetch }) {
  const qbo = createQuickBooksIntegration({
    env,
    fetch: fetcher,
    loadTokens: async () => {
      try { return JSON.parse((await getSecret(shopId, QUICKBOOKS_TOKEN_SECRET)) || 'null'); } catch { return null; }
    },
    saveTokens: tokens => saveSecret(env, shopId, QUICKBOOKS_TOKEN_SECRET, JSON.stringify(tokens)),
  });
  return qbo.getCompanyInfo();
}
