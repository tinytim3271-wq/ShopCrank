import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apiError,
  createQuickBooksIntegration,
  normalizeQuickBooksCustomer,
  normalizeQuickBooksInvoice,
  normalizeQuickBooksPayment,
} from "../src/integrations/quickbooks.mjs";

const ENV = Object.freeze({
  INTUIT_CLIENT_ID: "client-id",
  INTUIT_CLIENT_SECRET: "client-secret",
  INTUIT_REDIRECT_URI: "https://app.example.test/oauth/quickbooks/callback",
  INTUIT_ENVIRONMENT: "sandbox",
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stores(initialTokens) {
  let tokens = initialTokens;
  const states = new Map();
  const metadata = [];
  return {
    loadTokens: async () => tokens,
    saveTokens: async (next) => {
      tokens = next;
    },
    saveState: async (key, value) => states.set(key, value),
    loadState: async (key) => states.get(key),
    deleteState: async (key) => states.delete(key),
    saveSyncMetadata: async (value) => metadata.push(value),
    get tokens() {
      return tokens;
    },
    states,
    metadata,
  };
}

test("authorization URL persists state and a PKCE verifier without exposing secrets", async () => {
  const storage = stores();
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 1_000,
  });

  const result = await client.getAuthorizationUrl({ state: "state-123" });
  const url = new URL(result.authorizationUrl);
  const persisted = storage.states.get("state-123");

  assert.equal(result.state, "state-123");
  assert.equal(url.origin + url.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), ENV.INTUIT_REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(persisted.codeVerifier);
  assert.equal(persisted.createdAt, 1_000);
  assert.doesNotMatch(result.authorizationUrl, /client-secret/u);
  assert.equal("codeVerifier" in result, false);
});

test("callback exchanges code, consumes state, stores realm and tokens, and returns safe metadata", async () => {
  const storage = stores();
  storage.states.set("valid-state", {
    codeVerifier: "pkce-verifier",
    createdAt: 10_000,
    redirectUri: ENV.INTUIT_REDIRECT_URI,
  });
  let tokenRequest;
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 11_000,
    fetch: async (url, init) => {
      tokenRequest = { url: String(url), init };
      return jsonResponse({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 3600,
        x_refresh_token_expires_in: 8_640_000,
        token_type: "bearer",
      });
    },
  });

  const metadata = await client.exchangeCallback({
    code: "authorization-code",
    state: "valid-state",
    realmId: "company-42",
  });
  const body = new URLSearchParams(tokenRequest.init.body);

  assert.equal(tokenRequest.url, "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("code_verifier"), "pkce-verifier");
  assert.equal(storage.states.has("valid-state"), false);
  assert.equal(storage.tokens.refreshToken, "refresh-one");
  assert.equal(storage.tokens.realmId, "company-42");
  assert.deepEqual(metadata, {
    realmId: "company-42",
    expiresAt: 3_611_000,
    refreshExpiresAt: 8_640_011_000,
  });
  assert.equal("refreshToken" in metadata, false);
  assert.doesNotMatch(JSON.stringify(metadata), /refresh-one|client-secret/u);
});

test("refresh rotates stored tokens but never returns the refresh token", async () => {
  const storage = stores({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    realmId: "realm-1",
  });
  let requestBody;
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 50_000,
    fetch: async (_url, init) => {
      requestBody = new URLSearchParams(init.body);
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 1800,
      });
    },
  });

  const metadata = await client.refreshTokens();

  assert.equal(requestBody.get("grant_type"), "refresh_token");
  assert.equal(requestBody.get("refresh_token"), "old-refresh");
  assert.equal(storage.tokens.accessToken, "new-access");
  assert.equal(storage.tokens.refreshToken, "new-refresh");
  assert.equal(metadata.realmId, "realm-1");
  assert.equal("refreshToken" in metadata, false);
});

test("normalizers produce explicit bounded QBO payloads", () => {
  assert.deepEqual(
    normalizeQuickBooksCustomer({
      displayName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phone: "555-0100",
      billingAddress: { line1: "1 Engine Way", city: "London", postalCode: "N1" },
    }),
    {
      DisplayName: "Ada Lovelace",
      GivenName: "Ada",
      FamilyName: "Lovelace",
      PrimaryEmailAddr: { Address: "ada@example.test" },
      PrimaryPhone: { FreeFormNumber: "555-0100" },
      BillAddr: { Line1: "1 Engine Way", City: "London", PostalCode: "N1" },
    },
  );
  assert.deepEqual(
    normalizeQuickBooksInvoice({
      quickBooksCustomerId: "qbo-customer-1",
      number: "INV-7",
      date: "2026-10-08",
      lines: [
        {
          description: "Brake service",
          quantity: 2,
          unitPrice: 40,
          quickBooksItemId: "item-9",
        },
      ],
    }),
    {
      CustomerRef: { value: "qbo-customer-1" },
      DocNumber: "INV-7",
      TxnDate: "2026-10-08",
      Line: [
        {
          Amount: 80,
          DetailType: "SalesItemLineDetail",
          Description: "Brake service",
          SalesItemLineDetail: {
            ItemRef: { value: "item-9" },
            Qty: 2,
            UnitPrice: 40,
          },
        },
      ],
    },
  );
  assert.deepEqual(
    normalizeQuickBooksPayment({
      quickBooksCustomerId: "qbo-customer-1",
      quickBooksInvoiceId: "qbo-invoice-2",
      amount: 80,
      reference: "CARD-7",
    }),
    {
      CustomerRef: { value: "qbo-customer-1" },
      TotalAmt: 80,
      PaymentRefNum: "CARD-7",
      Line: [
        {
          Amount: 80,
          LinkedTxn: [{ TxnId: "qbo-invoice-2", TxnType: "Invoice" }],
        },
      ],
    },
  );
  assert.throws(
    () => normalizeQuickBooksCustomer({ displayName: "x".repeat(501) }),
    /exceeds 500 characters/u,
  );
});

test("sync methods use sandbox endpoints, normalized payloads, and persist QBO IDs", async () => {
  const storage = stores({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 9_999_999,
    realmId: "realm 7",
  });
  const requests = [];
  const responses = [
    { Customer: { Id: "c-1", DisplayName: "Shop Customer" } },
    { Invoice: { Id: "i-2", DocNumber: "INV-2" } },
    { Payment: { Id: "p-3", TotalAmt: 25 } },
  ];
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 100_000,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(responses.shift());
    },
  });

  const customer = await client.syncCustomer({ id: "local-c", displayName: "Shop Customer" });
  const invoice = await client.syncInvoice({
    id: "local-i",
    quickBooksCustomerId: "c-1",
    lines: [{ description: "Labor", quantity: 1, unitPrice: 25 }],
  });
  const payment = await client.syncPayment({
    id: "local-p",
    quickBooksCustomerId: "c-1",
    quickBooksInvoiceId: "i-2",
    amount: 25,
  });

  assert.match(
    requests[0].url,
    /^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/realm%207\/customer\?/u,
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), { DisplayName: "Shop Customer" });
  assert.equal(JSON.parse(requests[1].init.body).CustomerRef.value, "c-1");
  assert.equal(JSON.parse(requests[2].init.body).Line[0].LinkedTxn[0].TxnId, "i-2");
  assert.equal(customer.syncMetadata.quickBooksId, "c-1");
  assert.equal(invoice.syncMetadata.quickBooksId, "i-2");
  assert.equal(payment.syncMetadata.quickBooksId, "p-3");
  assert.deepEqual(
    storage.metadata.map(({ quickBooksId }) => quickBooksId),
    ["c-1", "i-2", "p-3"],
  );
});

test("sync refreshes expired access and retries exactly once after a 401", async () => {
  const storage = stores({
    accessToken: "expired",
    refreshToken: "refresh-1",
    expiresAt: 1,
    realmId: "realm-1",
  });
  const calls = [];
  let refreshNumber = 0;
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 1_000_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization });
      if (String(url).includes("/tokens/bearer")) {
        refreshNumber += 1;
        return jsonResponse({
          access_token: `access-${refreshNumber}`,
          refresh_token: `refresh-${refreshNumber + 1}`,
          expires_in: 3600,
        });
      }
      if (calls.filter((call) => call.url.includes("/customer")).length === 1) {
        return jsonResponse({ Fault: {} }, 401);
      }
      return jsonResponse({ Customer: { Id: "qbo-customer" } });
    },
  });

  const result = await client.syncCustomer({ id: "local-1", displayName: "Retry Customer" });
  const apiCalls = calls.filter((call) => call.url.includes("/customer"));

  assert.equal(refreshNumber, 2);
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[0].authorization, "Bearer access-1");
  assert.equal(apiCalls[1].authorization, "Bearer access-2");
  assert.equal(result.syncMetadata.quickBooksId, "qbo-customer");
});

test("unconfigured integration fails safely without leaking configuration values", async () => {
  const client = createQuickBooksIntegration({
    env: {},
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  await assert.rejects(
    client.getAuthorizationUrl(),
    (error) =>
      error.code === "INVALID_INPUT" &&
      /INTUIT_CLIENT_ID is required/u.test(error.message) &&
      !error.message.includes("secret"),
  );
});

const shopInvoice = {
  quickBooksCustomerId: "c-1",
  number: "INV-2050",
  subtotal: 350 + 68.99 + 10.5,
  tax: 35.43,
  lines: [
    { id: "l1", type: "labor", description: "Front brake labor", quantity: 1, hours: 2.5, laborRate: 140, unitPrice: 0, total: 350 },
    { id: "p1", type: "part", description: "Wagner pads", quantity: 1, unitPrice: 68.99, total: 68.99 },
    { id: "p2", type: "part", description: "Declined rotors", quantity: 2, unitPrice: 90, total: 180, approvalStatus: "declined" },
  ],
  fees: [{ description: "Shop supplies", amount: 10.5 }],
};

test("invoice lines satisfy QBO Qty x UnitPrice = Amount and skip declined work", () => {
  const payload = normalizeQuickBooksInvoice(shopInvoice);
  assert.deepEqual(payload.Line.map((line) => [line.Description, line.SalesItemLineDetail.Qty, line.SalesItemLineDetail.UnitPrice, line.Amount]), [
    ["Front brake labor", 2.5, 140, 350],
    ["Wagner pads", 1, 68.99, 68.99],
    ["Shop supplies", 1, 10.5, 10.5],
  ]);
  for (const line of payload.Line) {
    assert.equal(Math.round(line.SalesItemLineDetail.Qty * line.SalesItemLineDetail.UnitPrice * 100) / 100, line.Amount);
  }
  assert.equal("TxnTaxDetail" in payload, false);
});

test("invoice reconciles discounts to the Shop Crank subtotal", () => {
  const payload = normalizeQuickBooksInvoice({ ...shopInvoice, subtotal: 400, discountReason: "Loyalty" });
  const discount = payload.Line.at(-1);
  assert.equal(discount.DetailType, "DiscountLineDetail");
  assert.equal(discount.Amount, 29.49);
});

test("US manual sales tax sends TaxCodeRef per line and TxnTaxDetail (error 6000 fix)", () => {
  const payload = normalizeQuickBooksInvoice(
    { ...shopInvoice, lines: [...shopInvoice.lines, { type: "part", description: "Warranty part", quantity: 1, unitPrice: 0, total: 0, taxable: false }] },
    { tax: { mode: "manual", taxCodeId: "3" } },
  );
  assert.deepEqual(payload.Line.map((line) => line.SalesItemLineDetail.TaxCodeRef.value), ["TAX", "TAX", "NON", "TAX"]);
  assert.deepEqual(payload.TxnTaxDetail, { TxnTaxCodeRef: { value: "3" }, TotalTax: 35.43 });
});

test("US automated sales tax marks lines and lets QBO compute tax", () => {
  const payload = normalizeQuickBooksInvoice(shopInvoice, { tax: { mode: "ast" } });
  assert.ok(payload.Line.every((line) => line.SalesItemLineDetail.TaxCodeRef.value === "TAX"));
  assert.equal("TxnTaxDetail" in payload, false);
});

test("US automated sales tax preserves exempt fee flags", () => {
  const payload = normalizeQuickBooksInvoice({
    ...shopInvoice,
    tax: 8.25,
    lines: [{ type: "part", description: "Taxable part", quantity: 1, unitPrice: 20, taxable: true }],
    fees: [{ description: "Exempt fee", amount: 5, taxable: false }],
    subtotal: 25,
  }, { tax: { mode: "ast" } });

  assert.deepEqual(payload.Line.map((line) => line.SalesItemLineDetail.TaxCodeRef.value), ["TAX", "NON"]);
});

test("non-US companies get real tax code ids on every line", () => {
  const payload = normalizeQuickBooksInvoice(
    { ...shopInvoice, lines: [shopInvoice.lines[0], { ...shopInvoice.lines[1], taxable: false }], fees: [], subtotal: undefined },
    { tax: { mode: "global", taxCodeId: "8", exemptTaxCodeId: "4" } },
  );
  assert.deepEqual(payload.Line.map((line) => line.SalesItemLineDetail.TaxCodeRef.value), ["8", "4"]);
  assert.equal(payload.GlobalTaxCalculation, "TaxExcluded");
});

test("missing tax configuration fails before calling QuickBooks with a clear message", () => {
  assert.throws(
    () => normalizeQuickBooksInvoice(shopInvoice, { tax: { mode: "manual" } }),
    (error) => error.code === "QUICKBOOKS_TAX_CONFIG" && error.status === 409 && /sales tax rate/.test(error.message),
  );
  assert.throws(
    () => normalizeQuickBooksInvoice(shopInvoice, { tax: { mode: "none" } }),
    (error) => error.code === "QUICKBOOKS_TAX_CONFIG" && /does not track sales tax/.test(error.message),
  );
  assert.doesNotThrow(() => normalizeQuickBooksInvoice({ ...shopInvoice, tax: 0 }, { tax: { mode: "none" } }));
});

test("syncInvoiceWithTax detects the company tax setup and auto-selects the only rate", async () => {
  const storage = stores({ accessToken: "access", refreshToken: "refresh", expiresAt: 9_999_999_999, realmId: "realm-1" });
  const requests = [];
  const client = createQuickBooksIntegration({
    env: ENV,
    ...storage,
    now: () => 100_000,
    fetch: async (url, init) => {
      const href = String(url);
      requests.push({ href, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (href.includes("/preferences")) return jsonResponse({ Preferences: { TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } } });
      if (href.includes("/companyinfo/")) return jsonResponse({ CompanyInfo: { Country: "US" } });
      if (href.includes("/query")) {
        return jsonResponse({ QueryResponse: { TaxCode: [
          { Id: "TAX", Name: "TAX", Taxable: true },
          { Id: "NON", Name: "NON", Taxable: false },
          { Id: "3", Name: "Travis County 8.25%", Taxable: true },
        ] } });
      }
      return jsonResponse({ Invoice: { Id: "i-9", TxnTaxDetail: { TotalTax: 35.43 } } });
    },
  });
  const result = await client.syncInvoiceWithTax({ ...shopInvoice, id: "INV-2050" });
  const invoiceRequest = requests.find((request) => request.method === "POST");
  assert.match(invoiceRequest.href, /\/v3\/company\/realm-1\/invoice\?/u);
  assert.deepEqual(invoiceRequest.body.TxnTaxDetail, { TxnTaxCodeRef: { value: "3" }, TotalTax: 35.43 });
  assert.deepEqual(result.tax, { mode: "manual", expected: 35.43, quickBooks: 35.43, mismatch: false });
  assert.match(requests[1].href, /\/companyinfo\/realm-1\?/u);
  assert.equal(new URL(requests[2].href).searchParams.get("query"), "select * from TaxCode where Active = true maxresults 200");
});

test("QBO fault 6000 surfaces the code, detail, and where to fix tax settings", () => {
  const error = apiError({ Fault: { Error: [{ code: "6000", Message: "A business validation error has occurred", Detail: "Business Validation Error: Make sure all your transactions have a sales tax rate before you save." }] } }, 400);
  assert.match(error.message, /QuickBooks error 6000/);
  assert.match(error.message, /sales tax rate/);
  assert.match(error.message, /tax settings in Shop Crank/);
  assert.equal(error.faultCode, "6000");
});
