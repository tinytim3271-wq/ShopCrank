# Shop Crank fix plan

Status as of Oct 16, 2026. Each reported issue was checked against the code on
`main` (commit `7c282ed`) before it was planned. Items are ordered by priority:
security first, then defects in shipped features, then missing features.

Implementation for P0 and P1 is on branch `cursor/fix-plan-security-partstech-qbo-df88`.
That branch is stacked on PR #122.

## Verification summary

| # | Reported issue | Verified? | Status |
|---|---|---|---|
| 0 | Merge conflict markers on `main` | Yes, in 5 files | Fixed by PR #122 (this branch builds on it) |
| 1 | AutoZone Pro shows plaintext password to technicians | Yes | Fixed |
| 2 | Pending security PRs | Yes: #118 (live key gate) was closed unmerged | Ported and fixed |
| 3 | Open management ports | Partly: local mock server bound `0.0.0.0` | Fixed locally; production review open |
| 4 | Logging gaps | Partly | Some fixed; rest planned |
| 5 | PartsTech $0.00 quotes, malformed order, nothing ordered, parts never reach RO | Yes, all four | Fixed (needs PartsTech sandbox check) |
| 6 | QuickBooks tax error 6000 | Yes (no tax fields sent) | Fixed (needs Intuit sandbox check) |
| 7 | AI not tied into scan tool flow | Yes | Fixed |
| 8 | No licensed labor guide | Yes | Blocked on licenses |
| 9 | Texting, reminders, text-to-approve, photo/video inspections missing | Partly; much already exists | Planned |
| 10 | No public pricing page | **No.** `/pricing/` is live with all four plans | Small follow-up only |
| 11 | No onboarding/import path (Tekmetric, Shopmonkey) | Partly: generic CSV import exists | Planned |
| 12 | No iOS app | Yes | Blocked on Apple account |

---

## P0. Repository integrity

### 0. Merge conflict markers on `main`

Found: `app.js`, `index.html`, `src/runtime/home.js`, `worker/src/index.js`, and
`worker/src/login-email.mjs` contain `<<<<<<<`/`>>>>>>>` markers. Open PR #122
resolves all five.

Steps:
1. Review and merge PR #122 first.
2. Then merge this branch. Its first two commits are #122's, so they drop out
   of the diff once #122 lands.

Acceptance criteria:
- `rg -n '^(<<<<<<<|>>>>>>>)' --glob '!node_modules'` returns nothing on `main`.
- `npm run build:web`, `npm test`, and `npm run test:worker` pass on `main`.

## P0. Security

### 1. AutoZone Pro plaintext password (done)

Found: `GET /api/ordering/autozone?reveal=1` returned the saved shop password
to every ordering role, technicians included. The client then copied it to the
clipboard.

Done:
- The Worker never returns the password. `?reveal` now returns 403 for every
  role and writes an `ordering.autozone.reveal_denied` audit event.
- The client no longer asks for the password. The panel tells each user to sign
  in with their own AutoZone Pro user.
- Tests: `worker/test/autozone-ordering.test.mjs` and `src/modules/autozone-pro.test.mjs`.

Remaining (owner action):
- **Rotate the AutoZone Pro password now.** Any technician who used "Open
  AutoZone Pro" may have it on their clipboard or in browser history.
- Create an individual AutoZone Pro user for each technician. AutoZone Pro
  supports several users per commercial account.

Acceptance criteria:
- No API response contains a saved supplier password (covered by tests).
- The AutoZone Pro password has been rotated, with the date recorded here.

### 2. Live key programming gate (PR #118 was never merged) (done)

Found: PR #118 was closed unmerged on Oct 14. Its fix was missing from `main`.
`POST /api/diagnostics/authorize` with `mode: live` and an immobilizer
procedure only checked the plan and the AutoAuth login. Any shop-floor user
could mint a live key-programming token for any VIN. Duplicate `POST
/entities/orders` also silently overwrote existing work orders.

Done (ported from #118):
- Live immobilizer procedures need a Worker-stored order whose VIN matches and
  whose `estimateApproval` is approved and signed. The signature file is
  verified when one is present.
- Duplicate order POSTs return 409.
- The bay UI trusts only the order's approval, not the client-writable
  estimates register.
- Tests: `worker/test/diagnostics.test.mjs` and `src/modules/shop-os/bay.test.mjs`.

Acceptance criteria: a live `add_key` request with no signed RO, an unsigned
RO, or a different VIN returns 403 and mints no token (covered by tests).

### 3. Open management ports

Found: `server.mjs` and `server.js` (`npm start`) serve unauthenticated mock
APIs on `0.0.0.0:3000`. The J2534 HTTP bridge already binds `127.0.0.1`, and
its RPC handler requires the host token unless
`SHOP_CRANK_ALLOW_UNAUTHENTICATED_HOST=1` is set.

Done: both mock servers bind `127.0.0.1` unless `HOST` is set.

Remaining (needs infrastructure access, which this repo doesn't have):
1. Collect the earlier audit's list of open ports and hosts. The repo only
   deploys to Cloudflare (Pages and Workers), which has no management ports.
   Any open ports belong to machines outside this repo, such as a dev box,
   shop PCs, or an old VPS.
2. For each host, close SSH, RDP, database, and admin ports to the internet, or
   put them behind Cloudflare Access or Tunnel. Record the result here.
3. In the Windows app, confirm the Electron diagnostics bridge never listens
   on a non-loopback interface.

Acceptance criteria: an external scan of every listed host shows only 80 and
443 (or nothing); `npm start` is reachable only from localhost.

### 4. Logging and audit gaps

Done in this branch: audit events for the AutoZone reveal attempt, PartsTech
quote and order sessions (including unpriced counts), and AI diagnostic
analysis (codes and model, but no customer contact details).

Remaining:
1. `/api/quickbooks/*` (`worker/src/integration-routes.mjs`) writes no audit
   events. Add connect, disconnect, tax-settings change, and per-record sync
   events. `handleQuickBooks` will need a `recordAudit` dependency for this.
2. `/api/parts/*` (the generic PartsTech/Nexpart proxy) and
   `/api/messaging/send` have no audit events. Add them.
3. Add an admin "Security log" view over `audit_log`, filterable by kind.
4. Send Worker `console.error` output to Workers Logs or Logpush with a
   retention period, and alert on spikes in 401/403 responses.

Acceptance criteria: every credential change, external order, accounting sync,
and live diagnostic authorization leaves an `audit_log` row with no secret
values (`redactSensitive` already strips them).

## P1. Defects in shipped integrations

### 5. PartsTech ordering (done; needs PartsTech sandbox verification)

Found:
- **$0.00 quotes:** the mapper ran `Number(item.price)` on PartsTech's nested
  price object (`{ list, cost, core }`). That gives `NaN`, which became 0.
  Brand objects also rendered as `[object Object]`.
- **Malformed order:** `/order` forwarded whatever the client sent as `parts`:
  internal estimate fields, `undefined` keys, no validation. The `sessionId`
  branch only read session info and ordered nothing.
- **Nothing ordered:** no UI ever called `/order`.
- **Parts never reach the RO:** "Add" pushed into `state.pendingEstimateLines`,
  which nothing reads. Labor-guide and manual-labor "Add" had the same bug.

Done:
- The pricing parser reads list or retail price first. Cost-only quotes use the
  shop markup (`markupPercent`). Items with no price are flagged "Price
  unavailable" instead of showing $0.00. Core charges become their own RO line.
- `buildPartstechOrderRequest` sends only vendor fields (part number, whole
  quantity, brand or line card, part type, part ID). It validates input,
  includes the VIN and an RO-based PO number, accepts only HTTPS callbacks, and
  accepts only `partstech.com` redirect URLs. Order status is a separate
  `POST /integrations/partstech/order/status` call.
- The Ordering screen has a "repair order" selector. Quoted parts, labor-guide
  lines, and manual labor are appended to that RO's estimate as pending
  approval, and totals are recalculated. Adding to an approved RO requires
  re-approval.
- "Order this RO's PartsTech parts" opens PartsTech checkout and records the
  session on the RO. "Check order status" writes the order ID and status back
  to the RO and its lines.
- Tests: `src/modules/partstech.test.mjs`, `worker/test/integrations.test.mjs`,
  and `src/modules/estimate-workflow.test.mjs`.

Remaining:
1. **Verify the vendor contract in the PartsTech partner sandbox.** This needs
   PartsTech partner credentials. Request and response field names for
   `/catalog/quote` and `/punchout/quote/create` follow PartsTech's documented
   shape, but they have not been run against the live API. Adjust
   `partstechPricing` and `buildPartstechOrderRequest` if the sandbox differs.
2. Optional: register a PartsTech callback URL so order status updates without
   a manual "Check order status".
3. Optional: add a parts markup setting to shop settings. The client currently
   sends no `markupPercent`, so cost-only quotes are priced at cost.

Acceptance criteria (sandbox):
- Quoting a known part shows the same list price PartsTech shows.
- "Add to RO" puts the line, plus any core charge, on the selected RO with
  correct totals.
- Sending the RO opens PartsTech checkout with the same parts and quantities.
  After submitting there, "Check order status" shows the PartsTech order
  number on the RO.

### 6. QuickBooks tax error 6000 (done; needs Intuit sandbox verification)

Found: both invoice mappers sent no `TaxCodeRef` on lines and no
`TxnTaxDetail`. For companies with sales tax turned on, QBO rejects that with a
6000 business-validation error. Non-US companies get the "Make sure all your
transactions have a GST/HST rate" variant. Labor lines could also send
`Qty × UnitPrice ≠ Amount` (quantity 1 × unit price 0 against a $350 total).
Declined lines were synced, and fees were dropped.

Done:
- Invoice sync reads the company's `Preferences`, `CompanyInfo`, and active
  `TaxCode` list, then applies the matching tax mode:
  - US Automated Sales Tax: each line gets TAX or NON, and QBO calculates tax.
    The sync result flags any difference from Shop Crank's tax.
  - US manual sales tax: each line gets TAX or NON, plus `TxnTaxDetail` with
    the chosen tax code and `TotalTax`.
  - Non-US companies: each line gets a real tax code ID, and
    `GlobalTaxCalculation` is set to `TaxExcluded`.
  - Sales tax turned off in QuickBooks: a taxed invoice fails with a clear 409
    instead of a 6000.
- The tax code is picked automatically when there's only one candidate.
  Otherwise an admin chooses it with Integrations → QuickBooks → "Tax
  settings" (`GET`/`PUT /api/quickbooks/tax-settings`). Only active QBO tax
  codes are accepted.
- Line math: labor uses hours × rate, declined lines are skipped, fees are
  included, and a discount or fee line reconciles QBO to the Shop Crank
  subtotal.
- QBO faults report their code and detail. Tax-related 6000 errors point to
  the tax settings.
- Tests: `worker/test/quickbooks-integration.test.mjs`,
  `worker/test/integration-routes.test.mjs`, and `src/modules/quickbooks.test.mjs`.

Remaining:
1. Run one invoice per tax mode against Intuit sandbox companies: a US company
   with AST, a US company with manual tax, and a CA or UK company. This needs
   Intuit developer credentials (`INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`,
   `INTUIT_REDIRECT_URI`, `INTUIT_ENVIRONMENT=sandbox`).
2. If shops with AST want Shop Crank's tax amount kept exactly, test the AST
   `TxnTaxDetail.TotalTax` override in the sandbox before enabling it.
3. Retire one of the two QuickBooks code paths. `/api/quickbooks/*` is the one
   the UI uses; `/api/integrations/quickbooks/*` duplicates it. Both now send
   correct tax fields.

Acceptance criteria (sandbox): taxed and untaxed invoices sync in every mode
without error 6000 or 6070, and the QBO invoice total equals the Shop Crank
invoice total (or the mismatch is flagged when AST calculates tax).

### 7. AI in the scan-tool flow (done)

Found: codes read through the TOPDON RLink X7 / J2534 OBD bay were saved as
diagnostic sessions but never reached the AI. The "AI diagnostics" form ran
local keyword rules on codes typed in by hand.

Done:
- New endpoint `POST /api/diagnostics/analyze`. It validates, deduplicates, and
  classifies the codes (system, generic or manufacturer-specific, stored,
  pending, or permanent). It adds live data, the MIL state, and the RO's
  vehicle and complaint, then runs the request through the existing assistant
  session. That keeps the same provider routing, rate limit, usage accounting,
  and "never present a hypothesis as confirmed" guardrails.
- The OBD bay's latest scan has "Analyze codes with AI." The response is saved
  on the scan: ranked likely causes with evidence, then pinpoint tests.
  "Add AI estimate to RO-…" appends diagnostic and repair labor (labeled as
  an AI suggestion to verify against the labor guide) and the parts. Parts are
  forced to unpriced, so the AI never prices parts.
- Each analysis writes an audit event with the codes and model.
- Tests: `worker/test/diagnostic-ai.test.mjs` and `src/modules/diagnostic-ai.test.mjs`.

Remaining:
1. Add the same button to the OEM diagnostics screen (`diagnostics-ui.js`),
   which reads DTCs on the desktop app but has no RO link yet.
2. Once a licensed labor guide (item 8) is live, swap AI labor hours for book
   time automatically and price parts through PartsTech (item 5).

Acceptance criteria: reading a vehicle with codes, then pressing "Analyze codes
with AI," then "Add AI estimate," leaves an RO estimate with labor lines labeled
as AI suggestions and unpriced parts, pending customer approval.

## P2. Licensed data and customer communication

### 8. Licensed labor guide (blocked: licenses)

Found: `worker/src/integrations/labor-guide.mjs` returns 501 for ALLDATA and
ShopKey. The MOTOR path depends on PartsTech's labor endpoint. The fallback is
a labeled "web estimate, not book time" or manual entry. No book times are
faked, which is correct.

Needed (not code):
- A data license from MOTOR (direct, or MOTOR through the PartsTech labor
  add-on), ALLDATA, or Mitchell1/ShopKey. The license provides API
  credentials, endpoint documentation, and display and attribution terms.
- A decision on which provider to integrate first. MOTOR through PartsTech
  reuses the PartsTech credentials from item 5.

Steps once licensed:
1. Implement the provider adapter in `labor-guide.mjs` against the vendor
   sandbox, mapping operations to labor lines with `laborSource` set to the
   vendor and the book reference.
2. Show the vendor attribution the license requires.
3. Remove the 501 for that provider.

Acceptance criteria: looking up a common operation (front pads and rotors) for
a known VIN returns book hours matching the vendor's UI, labeled with the
provider.

### 9. Two-way texting, reminders, text-to-approve, digital inspections

Found (most of this already exists):
- Outbound SMS works: `/api/messaging/send` (Twilio, `worker/src/integrations/sms.mjs`).
  Inbound messages and STOP/START are received and stored by
  `/api/messaging/twilio/webhook/:shopId`. However, no UI reads
  `/api/messaging/threads` or lets staff reply. Inbound texts are invisible.
- Reminders exist (`reminders` entity, due date or mileage, SMS or email), but
  sending is manual, one at a time. Nothing sends on a schedule.
- Estimate approval links can be texted ("Text link"). Customers approve on
  the web page. Replying "YES" by text does not approve.
- Inspections have checklists and photo attachments (`photoKeys`). There's no
  video capture or upload, and no customer-facing inspection report link.

Steps:
1. **Inbox:** add a Messages screen showing `/api/messaging/threads` grouped by
   customer, with reply through `/api/messaging/send`, unread badges, and a link
   to the RO. `verifyTwilioWebhookSignature` already exists in `sms.mjs`;
   confirm that production has the Twilio auth token set so the check is enforced.
2. **Scheduled reminders:** add a Worker Cron Trigger that sends due reminders
   through the same consent-checked send path, marks `sentAt`, and skips
   opted-out numbers.
3. **Text-to-approve:** keep the signed web approval as the authorization of
   record. A "YES" reply should only mark the estimate as "customer replied
   yes" and send the link again. A text reply can't be tied to a signature, and
   item 2's live-key gate depends on signed approval.
4. **Video inspections:** accept `video/mp4` and `video/quicktime` in the
   upload path with a size cap (R2 multipart). Add a "Record video" control
   using `capture="environment"`, and a customer inspection link reusing
   `customer-document-links`.

Needed: Twilio A2P 10DLC brand and campaign registration for each sending
number (carrier requirement for US business texting).

Acceptance criteria: an inbound text appears in the inbox within seconds and
can be answered; due reminders go out without anyone pressing Send; a customer
can watch an inspection video from a texted link.

## P3. Growth

### 10. Public pricing page (not confirmed)

Found: `public/pricing/index.html` is deployed and live at
https://www.shopcrank.com/pricing/ with the Solo, Shop, Shop Pro, and
Enterprise prices ($69, $139, $279, $559). Features, signup, and founding pages
link to it.

Step: add a "Pricing" link to the sign-in screen and the app home footer
(`index.html`, `src/runtime/home.js`), which currently don't link to it.

Acceptance criteria: the pricing page can be reached in one click from the
sign-in screen.

### 11. Onboarding and Tekmetric/Shopmonkey import

Found: `src/modules/imports.js` imports generic CSV files for customers,
vehicles, and work orders with fixed column names. It has no presets for other
shop systems and no guided onboarding checklist.

Steps:
1. Get sample exports from Tekmetric (customers, vehicles, repair orders) and
   Shopmonkey (customers, vehicles, orders). Real shop exports are needed;
   don't guess column names.
2. Add column-mapping presets for each source to `IMPORT_TYPES`, with a
   preview-and-confirm step and duplicate detection (`/customers/duplicates`
   already exists).
3. Add a first-run checklist: shop profile, labor rate, tax rate, import data,
   connect payments, connect parts.

Acceptance criteria: a real Tekmetric export and a real Shopmonkey export each
import with no manual column edits, and a rerun creates no duplicates.

## P4. Platform

### 12. iOS app (blocked: Apple account)

Found: only Android is wrapped with Capacitor (`android/`). There is no `ios/`
project.

Needed (not code): an Apple Developer Program membership ($99/year) in the
company's name, a Mac with Xcode, an App Store Connect app record, a privacy
nutrition label, and a review account for Apple.

Steps:
1. `npx cap add ios`, then `npm run sync`.
2. Configure the bundle ID, icons, and the camera/microphone usage strings
   (inspections and voice).
3. Handle sign-in deep links (universal links for `www.shopcrank.com`).
4. Distribute through TestFlight, then submit for review.

Desktop-only features (J2534 diagnostics, the offline Windows build) stay off
on iOS.

Acceptance criteria: a TestFlight build signs in, shows the dispatch board, and
uploads an inspection photo from the camera.

---

## Requested features

These entries are documentation only. They are not planned or implemented in
this change.

### Linked bank accounts, credit cards, and cash apps for expense monitoring

**Requested by owner, Oct 16 2026, not started.**

Request: link the shop's bank accounts, credit cards, and cash services such
as Cash App and Venmo so shop expenses can be monitored in the accounting
section.

Context: the accounting section today has a chart of accounts and manually
entered expenses (`expenses` entities). No bank or card feeds exist.

Open questions for scoping: which aggregator to use (Plaid, MX, or Stripe
Financial Connections); whether Cash App and Venmo business accounts are
reachable through it; read-only access only; how imported transactions map to
expense categories and reconcile with QuickBooks sync (item 6); and data
retention and consent requirements.
