# ShopCrank integration setup

All integrations run from the existing Cloudflare Worker. Do not put credentials
in `wrangler.jsonc`, source control, Pages variables, or browser storage. Set
production credentials with `wrangler secret put NAME`; use `.dev.vars` only
for local development. Apply D1 migrations before enabling webhooks.

## Licensed labor guides

ShopCrank supports MOTOR and ALLDATA through a provider-neutral adapter. Until a
licensed provider returns an operation, labor remains editable and is shown as
**Unverified shop estimate**. A response is never marked verified merely
because an endpoint was configured.

Timothy must:

1. Ask MOTOR Information Systems for a MOTOR Data as a Service/API license that
   permits labor-time display inside a shop-management product, including
   multi-tenant resale if ShopCrank will serve other shops.
2. Ask ALLDATA for approved API/partner access and the same display/resale
   rights. Their normal web subscription is not automatically an API license.
3. Obtain the provider's base URL, labor-search path, authentication scheme,
   request contract, attribution requirements, and production approval.
4. Configure one or both providers:

| Variable | Purpose |
| --- | --- |
| `MOTOR_LABOR_BASE_URL` | MOTOR API origin |
| `MOTOR_LABOR_SEARCH_PATH` | Relative labor search path |
| `MOTOR_LABOR_API_KEY` / `MOTOR_LABOR_TOKEN` | Provider credential |
| `MOTOR_LABOR_AUTH_HEADER` / `MOTOR_LABOR_AUTH_SCHEME` | Optional non-default auth |
| `MOTOR_LABOR_SEARCH_METHOD` | `POST` (default) or `GET` |
| `MOTOR_LABOR_LICENSE_CONFIRMED` | Set to `true` only after the provider contract grants the required use rights |
| `ALLDATA_LABOR_*` | ALLDATA equivalents |
| `LABOR_PROVIDER` | Optional preferred provider: `motor` or `alldata` |
| `LABOR_PROVIDER_TIMEOUT_MS` | Optional timeout, 100–30000 ms |

The adapter deliberately does not guess private vendor paths. Update the
configuration to the contract supplied during onboarding. A configured
endpoint and credential alone never activate labor data: set the provider's
`*_LABOR_LICENSE_CONFIRMED=true` only after verifying the license, display,
attribution, and (where applicable) multi-tenant resale terms. Until then the
guide returns an unverified manual estimate.

## PartsTech and Nexpart

Timothy must create/approve PartsTech and WHI/Epicor Nexpart partner accounts
and request credentials for each contracted capability. Search, quote, order,
and punch-out are independently enabled so ShopCrank does not claim an operation
the contract does not include.

For each `PARTSTECH` or `NEXPART` prefix configure:

- `_BASE_URL`, `_API_KEY` or `_TOKEN` (or `_USERNAME` + `_PASSWORD`)
- `_SEARCH_PATH`, `_QUOTE_PATH`, `_ORDER_PATH`, `_STATUS_PATH` as supplied
- `_PUNCHOUT_URL` when the supplier provides a hosted catalog
- Optional per-operation `_METHOD`, `_AUTH_HEADER`, and `_AUTH_SCHEME`
- Optional global `PARTS_PROVIDER_TIMEOUT_MS`

AutoZone Pro remains available and unchanged. Never provide supplier passwords
to browser code; the Worker sends API credentials server-side.

## Built-in SMS with Twilio

1. Create a Twilio account owned by the business.
2. Buy/port an SMS-capable US number or assign one to a Messaging Service.
3. Complete brand and campaign registration for A2P 10DLC. Describe estimate
   approvals, repair-status updates, pickup notices, and payment links; provide
   the opt-in workflow and sample messages.
4. Configure:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_MESSAGING_SERVICE_SID` (recommended) or `TWILIO_FROM_NUMBER`
   - `TWILIO_WEBHOOK_URL`, exactly matching the signed inbound URL:
     `https://HOST/api/messaging/twilio/webhook/SHOP_ID`
5. Set that URL as the incoming-message webhook for the number.

Set the number's delivery status callback to
`https://HOST/api/messaging/twilio/status/SHOP_ID`. ShopCrank also sends this
callback URL with each outbound message. Delivery callbacks are signature
verified and stored, including callbacks arriving before the outbound message
record.

Outbound messages are blocked unless the shop records explicit opt-in in the
Messaging inbox. Record the customer's E.164 number, select **Record explicit
opt-in**, and confirm consent was obtained and documented. Staff can record an
opt-out; exact STOP-family messages also opt out and block sends, while
START/UNSTOP restores consent. Consent changes record the staff account when
entered manually. Keep the consent record, honor quiet hours, and do not send
marketing traffic under a transactional campaign. Inbound and outbound
messages are stored in D1 with provider delivery status.
Twilio may also enforce its own opt-out list. Do not send marketing traffic
under the transactional campaign. The feature is hidden/disabled when
credentials are absent.

Estimate approval links, ready-for-pickup notices, and Stripe-hosted
text-to-pay links use the same sender. Payment card data never passes through
SMS or ShopCrank.

## QuickBooks Online

1. Create an app at the Intuit Developer portal and enable the
   `com.intuit.quickbooks.accounting` scope.
2. Add the exact redirect URI
   `https://HOST/api/quickbooks/callback` (and the local Wrangler URI for
   sandbox testing).
3. Configure `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`,
   `INTUIT_REDIRECT_URI`, and `INTUIT_ENVIRONMENT` (`sandbox` first, then
   `production` after Intuit review).
4. Configure `INTUIT_DEFAULT_ITEM_ID` to an active QuickBooks Service item used
   when a ShopCrank invoice has no item mapping.
5. An admin connects from **Integrations**. OAuth state and PKCE verifier data
   are short-lived; access and refresh tokens are encrypted in D1 using
   `INTEGRATION_ENCRYPTION_KEY`.

Current synchronization is one-way ShopCrank → QBO for customers, invoices, and
payments. Re-sync updates the mapped QuickBooks object using its current
`SyncToken`; deterministic request IDs make safe retries idempotent. Sync
metadata prevents losing the QBO ID. This does not import edits
from QBO or perform accounting reconciliation; verify the sandbox company
before production use.

## Stripe Revenue Recognition (per-shop)

ShopCrank can export **general import** CSVs so each shop's Stripe Revenue
Recognition reports include:

- Non-Stripe payments (cash, check, bank, and manual card/processor without a
  Stripe id)
- Recognition start/end dates for work (work-order open → invoice closeout)

Stripe has no public API for Revenue Recognition CSV upload. Automation uses
the [Amazon S3 Data Management connector](https://docs.stripe.com/data/import-external-data/connectors/s3).
Cloudflare R2 cannot replace this connector (it requires AWS account ID + IAM).

### Platform (once)

1. Create an S3 bucket and an IAM user/role that can `s3:PutObject` (and list)
   under `revrec/`.
2. Set Worker secrets / `.dev.vars`:
   - `REVREC_S3_BUCKET`
   - `REVREC_S3_REGION` (default `us-east-1`)
   - `REVREC_S3_ACCESS_KEY_ID`
   - `REVREC_S3_SECRET_ACCESS_KEY`
3. Apply D1 migration `0012_revenue_recognition_exports.sql`.
4. Deploy the Worker (cron `0 6 * * *` UTC runs enabled shops daily).

### Per shop

1. Connect the shop's Stripe secret + webhook keys (Payments) as usual.
2. Enable **Stripe Revenue Recognition** on that Stripe account.
3. In Stripe Dashboard → **Data Management** → Amazon S3 connector, grant
   Stripe read access to folder `revrec/{shopId}/general/` and map files to
   Revenue Recognition **general / transactions** import.
4. In ShopCrank → **Shop operations → Ordering → Stripe Revenue Recognition**,
   enable sync (admins/owners). Use **Export now** or **Download CSV** to
   verify the file before relying on the daily job.

Object keys look like `revrec/{shopId}/general/2026-10-16.csv`. Stripe replaces
rows that share the same Source + Transaction ID (+ Split ID). Keep accounting
periods open when backfilling (see Stripe accounting period control docs).

Checkout and Terminal webhooks store `stripePaymentIntentId` / `stripeChargeId`
on payment records when available so schedule overrides can target `ch_` / `py_`
ids instead of Checkout `cs_` session ids.

## Stripe SaaS subscription billing

This is the ShopCrank platform subscription, separate from each shop's Stripe
account used to collect customer invoices.

1. In the platform Stripe account create products and recurring USD prices:
   - Solo: $69 monthly; $690 annual
   - Shop: $139 monthly; $1,390 annual
   - Shop Pro: $279 monthly; $2,790 annual
   - Enterprise: $559 monthly; $5,590 annual
   - Founding Solo: $49 monthly; $490 annual
   - Founding Shop: $99 monthly; $990 annual
   - Founding Pro: $199 monthly; $1,990 annual
2. Founding prices must not be publicly selectable; they remain invite-only.
3. Enable Stripe Billing customer portal cancellation/payment-method features.
4. Create a webhook for `https://HOST/api/billing/webhook` subscribing to:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, and
   `invoice.payment_failed`.
5. Set `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`, and every
   `STRIPE_PRICE_<PLAN>_MONTHLY` / `_ANNUAL` variable listed in
   `.dev.vars.example`.

Checkout fails closed if a real configured Price ID is absent. Webhooks are
signature-checked and idempotently stored in `billing_events`; subscription
status and plan capabilities update from lifecycle events.

## Support

Set `SUPPORT_EMAIL_TO`, `SUPPORT_EMAIL_FROM`, and optionally
`STATUS_PAGE_URL`. `SUPPORT_EMAIL_FROM` must be allowed by the existing
Cloudflare Email Routing `EMAIL` binding. Tickets are always stored in D1 even
if email delivery is unavailable; the API reports notification status.

## Deployment checklist

1. Configure and test every provider in its sandbox.
2. Run `npm run db:migrate:local`, `npm run validate`, and security scanning.
3. Apply `npm run db:migrate:remote` only during an approved production change.
4. Add secrets with `wrangler secret put`; never paste values into a PR.
5. Confirm webhook signatures and replay/idempotency behavior.
6. Obtain Timothy's written approval for licenses, A2P campaign, Intuit app,
   Stripe catalog, support sender, and production activation.
