// Versioned contract for what every assistant tool returns. The health check and
// the executeAssistantTool wrapper validate real output against these shapes, so
// a field that disappears or changes type shows up as schema drift.
//
// Changing a tool's output: update its `returns` shape, bump TOOL_CONTRACTS_VERSION
// (major for removed/retyped fields, minor for added tools or fields, patch for
// docs), set the tool's `since`, and add a TOOL_CONTRACTS_CHANGELOG entry.
// worker/test/tool-contracts.test.mjs fails if the registry and this file disagree.
//
// Shapes use a small JSON-Schema subset (type, properties, required, items, enum,
// anyOf, additionalProperties); see ./schema.mjs.

export const TOOL_CONTRACTS_VERSION = '1.1.0';

export const TOOL_CONTRACTS_CHANGELOG = Object.freeze([
  {
    version: '1.1.0',
    date: '2026-10-30',
    changes: [
      'Added search_youtube_videos: { kind: "youtube_search_results", query, videos: [{ videoId, title, channelTitle, publishedAt, thumbnailUrl, url }], displayedInApp, note }.',
      'Added show_youtube_video: { kind: "youtube_player", videoId, title, url, embedUrl, displayedInApp, note }.',
      'Both are text-channel only (tech assistant chat); voice sessions never see or run them.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-30',
    changes: [
      'Initial contract for every tech, accounting and front-desk assistant tool.',
      'Every tool may instead return the error envelope { error: string }.',
    ],
  },
]);

const S = { type: 'string' };
const N = { type: 'number' };
const I = { type: 'integer' };
const B = { type: 'boolean' };
const ANY = {};
const nullable = schema => ({ ...schema, type: [schema.type, 'null'] });
const arr = (items = ANY) => ({ type: 'array', items });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const literal = value => ({ type: 'string', enum: [value] });

/** Soft failure every tool may return instead of its success shape. */
export const ERROR_ENVELOPE = obj({ error: S }, ['error']);

const LOOKUP_RESULT = obj({ entityType: S, records: arr({ type: 'object' }), count: I, readOnly: B });
const SEARCH_RESULT = obj({
  query: S,
  entityTypes: arr(S),
  count: I,
  records: arr(obj({ entityType: S, id: S, updatedAt: nullable(S), snippet: S, record: { type: 'object' } }, ['entityType', 'id', 'record'])),
  readOnly: B,
}, ['count', 'records']);
const REVIEW_DRAFT = { requiresUserReview: { type: 'boolean', enum: [true] }, saved: { type: 'boolean', enum: [false] } };
const ESTIMATE_BREAKDOWN = obj({ labor: N, parts: N, shopSupplies: N, tax: N, total: N });

const TECH = { persona: 'tech_assistant', role: 'admin' };
const FRONT_DESK = { persona: 'front_desk' };

// `dependencies` names what a tool needs at runtime (health-check dependency ids).
// `canary` is a read-only call the health check makes to compare live output with
// `returns`; tools that write records or book time have no canary. `network: true`
// canaries reach a third party and are skipped in dry runs; `requires` names the
// env var without which the canary reports not_configured; `channel` defaults to voice.
export const TOOL_CONTRACTS = Object.freeze({
  // --- Tech assistant -------------------------------------------------------
  get_shop_info: {
    since: '1.0.0',
    summary: 'Shop name, contact, hours, labor/tax rates, supplies policy, and what is known about the caller.',
    dependencies: ['d1'],
    returns: obj({ shopName: S, phone: ANY, address: ANY, hours: ANY, laborRate: N, taxRate: N, shopSuppliesPolicy: S, callerContext: ANY }, ['shopName', 'laborRate', 'taxRate', 'shopSuppliesPolicy']),
    canary: { ...TECH, args: {} },
  },
  lookup_customer_and_vehicles: {
    since: '1.0.0',
    summary: 'Read-only search of customers, vehicles, orders, estimates and appointments.',
    dependencies: ['d1'],
    returns: SEARCH_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  calculate_service_estimate: {
    since: '1.0.0',
    summary: 'Ballpark estimate totals and lines from the shop labor rate and licensed labor times.',
    dependencies: ['d1', 'labor-guide'],
    returns: obj({ vehicle: S, laborRate: N, taxRate: N, laborHours: N, labor: N, parts: N, shopSupplies: N, fees: arr(), subtotal: N, tax: N, total: N }, ['laborRate', 'labor', 'parts', 'tax', 'total']),
    canary: { ...TECH, args: { vehicle: { year: '2020', make: 'Honda', model: 'Civic' }, complaint: 'oil change', requestedServices: ['oil change'] }, network: true },
  },
  save_call_intake_and_estimate: {
    since: '1.0.0',
    summary: 'Saves a customer, vehicle, estimate and repair order from a call; returns their references and totals.',
    dependencies: ['d1'],
    returns: obj({ saved: B, orderId: S, estimateNumber: S, customer: S, vehicle: S, complaint: S, estimateTotal: N, estimateBreakdown: ESTIMATE_BREAKDOWN, action: { type: 'object' } }, ['saved', 'orderId', 'estimateNumber', 'estimateTotal']),
    canary: null,
  },
  lookup_job: {
    since: '1.0.0',
    summary: 'Read-only repair-order lookup by id or query.',
    dependencies: ['d1'],
    returns: LOOKUP_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  lookup_estimate: {
    since: '1.0.0',
    summary: 'Read-only estimate lookup by id or query.',
    dependencies: ['d1'],
    returns: LOOKUP_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  lookup_customer: {
    since: '1.0.0',
    summary: 'Read-only customer lookup by id or query.',
    dependencies: ['d1'],
    returns: LOOKUP_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  lookup_parts: {
    since: '1.0.0',
    summary: 'Read-only lookup of the shop parts inventory (entity type "inventory").',
    dependencies: ['d1', 'inventory'],
    returns: LOOKUP_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  search_shop_records: {
    since: '1.0.0',
    summary: 'Read-only search across shop record types with snippets.',
    dependencies: ['d1', 'inventory'],
    returns: SEARCH_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  prepare_estimate_work_order: {
    since: '1.0.0',
    summary: 'Unsaved estimate/work-order draft for staff review, priced with the shop labor and tax rates.',
    dependencies: ['d1'],
    returns: obj({
      kind: literal('estimate_work_order_draft'),
      draft: obj({ customer: { type: 'object' }, vehicle: { type: 'object' }, complaint: S, requestedServices: arr(S), parts: arr({ type: 'object' }), labor: arr({ type: 'object' }) }),
      pricing: obj({ laborRate: N, taxRate: N }),
      ...REVIEW_DRAFT,
    }),
    canary: { ...TECH, args: { customer: { name: 'Health Check' }, vehicle: { description: '2020 Honda Civic' }, complaint: 'Health check canary' } },
  },
  lookup_labor_time: {
    since: '1.0.0',
    summary: 'Verified numeric labor hours from a licensed labor guide, or source "unavailable" with no operations.',
    dependencies: ['labor-guide'],
    returns: obj({
      source: { type: 'string', enum: ['licensed_labor_guide', 'unavailable'] },
      operations: arr(obj({ operation: ANY, hours: N, source: ANY }, ['hours'])),
      note: S,
    }, ['source', 'operations']),
    canary: { ...TECH, args: { operation: 'front brake pads', vehicle: { year: '2020', make: 'Honda', model: 'Civic' } }, network: true },
  },
  lookup_dtc: {
    since: '1.0.0',
    summary: 'Shop history and knowledge for an OBD-II code.',
    dependencies: ['d1'],
    returns: obj({ code: S, history: arr(obj({ type: S, id: ANY, status: ANY }, ['type'])), knowledge: arr(), citations: arr() }),
    canary: { ...TECH, args: { code: 'P0301' } },
  },
  search_shop_knowledge: {
    since: '1.0.0',
    summary: 'Shop knowledge-base results with [KB-n] citations.',
    dependencies: ['d1'],
    returns: obj({ results: arr(), citations: arr(), note: S }),
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  remember_shop_fact: {
    since: '1.0.0',
    summary: 'Saves a shop memory; returns its id and permission.',
    dependencies: ['d1'],
    returns: obj({ saved: B, id: S, permission: S }, ['saved', 'id']),
    canary: null,
  },

  // --- Tech assistant, text channel only -----------------------------------
  search_youtube_videos: {
    since: '1.1.0',
    summary: 'Embeddable, safe-search YouTube videos for a query; the chat UI shows thumbnails with play buttons.',
    dependencies: ['youtube'],
    returns: obj({
      kind: literal('youtube_search_results'),
      query: S,
      videos: arr(obj({ videoId: S, title: S, channelTitle: S, publishedAt: S, thumbnailUrl: S, url: S })),
      displayedInApp: { type: 'boolean', enum: [true] },
      note: S,
    }),
    canary: { ...TECH, channel: 'text', args: { query: 'brake pad replacement', maxResults: 1 }, network: true, requires: 'YOUTUBE_API_KEY' },
  },
  show_youtube_video: {
    since: '1.1.0',
    summary: 'Player directive for one YouTube video; the chat UI renders the embedded player.',
    dependencies: [],
    returns: obj({ kind: literal('youtube_player'), videoId: S, title: S, url: S, embedUrl: S, displayedInApp: { type: 'boolean', enum: [true] }, note: S }),
    canary: { ...TECH, channel: 'text', args: { video: 'https://youtu.be/dQw4w9WgXcQ' } },
  },

  // --- Accounting (tech assistant, accounting roles) -------------------------
  lookup_invoice: {
    since: '1.0.0',
    summary: 'Read-only invoice lookup by id or query.',
    dependencies: ['d1'],
    returns: LOOKUP_RESULT,
    canary: { ...TECH, args: { query: 'healthcheck-canary' } },
  },
  list_invoices_and_payments: {
    since: '1.0.0',
    summary: 'Invoices and payments (payments include Stripe checkout payments recorded by the shop webhook).',
    dependencies: ['d1', 'stripe-webhooks'],
    returns: obj({ invoices: arr({ type: 'object' }), payments: arr({ type: 'object' }) }),
    canary: { ...TECH, args: { query: 'healthcheck-canary', limit: 1 } },
  },
  get_financial_report: {
    since: '1.0.0',
    summary: 'Invoiced, collected and outstanding totals for a date range.',
    dependencies: ['d1', 'stripe-webhooks'],
    returns: obj({ from: S, to: S, invoiceCount: I, invoiced: N, collected: N, outstanding: N }),
    canary: { ...TECH, args: { from: '2026-01-01', to: '2026-01-31' } },
  },
  list_expenses: {
    since: '1.0.0',
    summary: 'Up to 50 recorded expenses in a date range.',
    dependencies: ['d1'],
    returns: obj({ expenses: arr({ type: 'object' }) }),
    canary: { ...TECH, args: {} },
  },
  get_payroll_summary: {
    since: '1.0.0',
    summary: 'Up to 50 payroll records for a period.',
    dependencies: ['d1'],
    returns: obj({ period: S, records: arr({ type: 'object' }) }),
    canary: { ...TECH, args: { period: '2026-01' } },
  },
  request_quickbooks_sync: {
    since: '1.0.0',
    summary: 'Unsaved QuickBooks sync request the admin confirms under Integrations > QuickBooks.',
    dependencies: ['quickbooks'],
    returns: obj({ kind: literal('quickbooks_sync_request'), entity: { type: 'string', enum: ['customers', 'invoices', 'payments'] }, message: S, ...REVIEW_DRAFT }),
    canary: { ...TECH, args: { entity: 'customers' } },
  },
  prepare_refund: {
    since: '1.0.0',
    summary: 'Unsaved refund draft for admin review.',
    dependencies: [],
    returns: obj({ kind: literal('refund_draft'), invoiceNumber: S, amount: N, reason: S, ...REVIEW_DRAFT }),
    canary: { ...TECH, args: { invoiceNumber: 'HC-0', amount: 0, reason: 'health check' } },
  },
  prepare_pricing_change: {
    since: '1.0.0',
    summary: 'Unsaved labor-rate change draft for admin review.',
    dependencies: [],
    returns: obj({ kind: literal('pricing_change_draft'), laborRate: nullable(N), note: S, ...REVIEW_DRAFT }),
    canary: { ...TECH, args: { note: 'health check' } },
  },

  // --- Front desk -------------------------------------------------------------
  check_appointment_availability: {
    since: '1.0.0',
    summary: 'Open appointment times by day (AI phone booking must be enabled).',
    dependencies: ['d1'],
    returns: obj({ today: S, timeZone: S, hours: ANY, days: arr(obj({ date: S, times: arr() })) }, ['days']),
    canary: null,
  },
  book_appointment: {
    since: '1.0.0',
    summary: 'Books a calendar slot; booked: true with the appointment, or booked: false with alternatives.',
    dependencies: ['d1'],
    returns: obj({ booked: B, appointmentId: S, date: S, time: S, service: ANY, customerName: ANY, returningCustomer: B }, ['booked', 'appointmentId', 'date', 'time']),
    canary: null,
  },
  get_shop_hours_and_directions: {
    since: '1.0.0',
    summary: 'Customer-facing shop details: hours, address, contact, services, payment and policies.',
    dependencies: ['d1'],
    returns: obj({
      shopName: ANY, address: ANY, hours: ANY, holidayHours: ANY, closures: ANY, landmarks: ANY, parking: ANY, phone: ANY,
      servicesOffered: arr(), servicesNotOffered: arr(), makesServiced: arr(), paymentMethods: arr(), warrantyPolicy: ANY, bookingMode: ANY,
    }, ['shopName', 'hours', 'servicesOffered', 'paymentMethods']),
    canary: { ...FRONT_DESK, args: {} },
  },
  answer_pricing_question: {
    since: '1.0.0',
    summary: 'Only the shop\'s published prices for a service plus the approved quote wording.',
    dependencies: ['d1'],
    returns: obj({ publishedPrices: arr({ type: 'object' }), diagnosticFee: ANY, wording: S, pricesVary: B, laborRatePerHour: N }, ['publishedPrices', 'wording', 'pricesVary']),
    canary: { ...FRONT_DESK, args: { service: 'oil change' } },
  },
  search_customer_faq: {
    since: '1.0.0',
    summary: 'Customer-safe FAQ and policy results.',
    dependencies: ['d1'],
    returns: obj({ results: arr(obj({ ref: ANY, title: ANY, text: ANY }, [])), note: S }),
    canary: { ...FRONT_DESK, args: { query: 'hours' } },
  },
  check_my_vehicle_status: {
    since: '1.0.0',
    summary: 'Caller-ID-verified status and promised time of the caller\'s own vehicles, or why it is unavailable.',
    dependencies: ['d1'],
    returns: {
      anyOf: [
        obj({ available: { type: 'boolean', enum: [false] }, message: S }),
        obj({ verified: { type: 'boolean', enum: [false] }, message: S }),
        obj({ verified: { type: 'boolean', enum: [true] }, vehicles: arr(obj({ vehicle: S, status: S, promisedTime: ANY })) }),
      ],
    },
    canary: { ...FRONT_DESK, args: {} },
  },
  request_appointment: {
    since: '1.0.0',
    summary: 'Records an appointment request for staff to confirm.',
    dependencies: ['d1'],
    returns: obj({ requested: B, reference: S, message: S }),
    canary: null,
  },
  take_message: {
    since: '1.0.0',
    summary: 'Saves a callback message and notifies staff.',
    dependencies: ['d1'],
    returns: obj({ saved: B, reference: S, staffNotified: B, message: S }),
    canary: null,
  },
  save_caller_intake: {
    since: '1.0.0',
    summary: 'Saves the caller intake for staff; returns the repair-order reference.',
    dependencies: ['d1'],
    returns: obj({ saved: B, reference: S, message: S }),
    canary: null,
  },
  transfer_to_staff: {
    since: '1.0.0',
    summary: 'Signals the call bridge to transfer the caller.',
    dependencies: [],
    returns: obj({ transfer: { type: 'boolean', enum: [true] }, reason: S, message: S }),
    canary: { ...FRONT_DESK, args: { reason: 'health check' } },
  },
});

/** Assistant tools that rely on a health-check dependency id. */
export function toolsUsingDependency(dependency) {
  return Object.entries(TOOL_CONTRACTS)
    .filter(([, contract]) => contract.dependencies.includes(dependency))
    .map(([name]) => name);
}
