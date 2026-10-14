# Shop Crank Dispatch

This repository, [`tinytim3271-wq/ShopCrank`](https://github.com/tinytim3271-wq/ShopCrank),
is the canonical home for Shop Crank, hosted at
[`https://www.shopcrank.com`](https://www.shopcrank.com).

Shop Crank is a local-first shop dispatch and work-order PWA with cloud
synchronization on **Cloudflare** (Pages, Workers, D1, R2, Workers AI). The
public SaaS architecture is documented in
[`docs/cloudflare-saas-architecture.md`](docs/cloudflare-saas-architecture.md).
The app supports a public customer-auth path using the `shopcrank_session`
HTTP-only cookie, with magic-link and Google sign-in endpoints at
`/api/auth/magic-link`, `/api/auth/google`, `/api/auth/callback`, and `/api/auth/logout`.
- **Pages** serves the static PWA.
- **Workers** provides the existing HTTP API routes under `/api`.
- **D1** stores tenant accounts, identity mappings, entities, audit events, and
  encrypted integration configuration.
- **R2** stores inspection photos, signatures, and Windows downloads.
- **Anthropic Claude** or **Google Gemini** (when `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` are set) with **Workers AI** fallback powers `/api/ai/assistant` and AgentPhone responses. See `docs/AI_CONVERSATIONAL.md`.
- **Cloudflare Access** should be reserved for internal/operator surfaces as the
  product moves to public SaaS signup, login, and billing.

The PWA remains usable offline with `localStorage` (`shopcrank-dispatch-v1`) and
queues non-sensitive entity mutations until connectivity returns.

## Deployment Targets (Source of Truth)

| Target | Purpose | Source of truth |
| --- | --- | --- |
| Cloudflare Pages | Hosts the production web/PWA shell | `.github/workflows/cloudflare-pages.yml` |
| Cloudflare Worker | Hosts `/api/*` backend endpoints | `wrangler.jsonc`, `worker/` |
| Cloudflare R2 | Stores files/download artifacts | `.github/workflows/deploy-r2.yml` |
| Android APK | Builds Android package from Capacitor wrapper | `.github/workflows/android-apk.yml`, `android/` |
| Windows Desktop | Builds desktop installer and release artifacts | `.github/workflows/windows-desktop.yml`, `desktop/` |

Active deployment paths are Cloudflare workflows and `wrangler.jsonc` only.

## Local Development

### Setup

```bash
nvm use
npm ci
cp .dev.vars.example .dev.vars   # only for local Worker development
```

### Run/build/test/lint

```bash
npm run dev --if-present
npm run build --if-present
npm run test --if-present
npm run lint --if-present
npm run dev:worker --if-present
```

`lint` runs ESLint across the modular `src/` entry/shared/runtime seams while intentionally excluding generated `app.js` and the current legacy runtime monolith file.

### Serve the local frontend shell

```bash
npm ci
npm run build:web
python -m http.server 3000 --bind 127.0.0.1
```

Open <http://127.0.0.1:3000/>. Localhost and packaged Electron builds use the
seeded admin profile for the offline UI. Cloud API requests remain protected.

Source lives in `src/`; `npm run build:web` refreshes committed `app.js`.

## Environment Variables

| Variable | Purpose | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Auth for Pages/Worker deploy and R2 publish (`wrangler`) | GitHub Actions (`cloudflare-pages.yml`, `windows-desktop.yml`, `deploy-r2.yml`) |
| `CLOUDFLARE_ACCOUNT_ID` | Selects target Cloudflare account in CI/deploy scripts | GitHub Actions + local deploy CLI |
| `CLOUDFLARE_D1_DATABASE_ID` | Optional CI override for Worker D1 binding `database_id` | GitHub Actions variable (`cloudflare-pages.yml`) |
| `CLOUDFLARE_PAGES_PROJECT` | Optional Pages project name override | GitHub Actions variable (`cloudflare-pages.yml`) |
| `CLOUDFLARE_APP_ORIGIN` | Optional smoke-check origin (defaults to `https://www.shopcrank.com`) | GitHub Actions variable (`cloudflare-pages.yml`) |
| `CLOUDFLARE_ALLOWED_ORIGINS` | Optional Worker CORS origins override (defaults in `wrangler.jsonc` include `https://www.shopcrank.com`) | GitHub Actions variable (`cloudflare-pages.yml`) |
| `CLOUDFLARE_DEPLOY_ENABLED` | Set to `false` to skip production Cloudflare publish | GitHub Actions variable (`cloudflare-pages.yml`) |
| `CLOUDFLARE_R2_BUCKET` (or `R2_BUCKET`) | Target R2 bucket for download/object uploads | GitHub Actions variable/secret (`deploy-r2.yml`, `windows-desktop.yml`) |
| `INTEGRATION_ENCRYPTION_KEY` | Encrypts integration secrets at rest in D1 | Worker secret (`wrangler secret put`) |
| `DIAGNOSTICS_SIGNING_PRIVATE_KEY` | Required ECDSA signing key for `/api/diagnostics/authorize` | Worker secret (`wrangler secret put`) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_ADMIN_EMAILS` | Cloudflare Access/admin bootstrap for internal surfaces | Worker secrets / `.dev.vars` for local development |
| `DEV_AUTH_BYPASS` | Local-only auth bypass for `wrangler dev`; never production | `.dev.vars` local only |

## Shop integrations (PartsTech, MOTOR labor, QuickBooks)

Per-shop credentials are encrypted at rest in D1 (`integration_secrets` + `INTEGRATION_ENCRYPTION_KEY`).
Unconfigured integrations return **not connected** and fail closed — they never invent parts, labor times, or accounting responses.

| Integration | API routes | Secrets / signup |
| --- | --- | --- |
| PartsTech parts | `GET/POST/DELETE /api/integrations/partstech`, `POST .../quote`, `POST .../order` | Shop stores partner+user API keys in D1 after creating a PartsTech partner account |
| Labor guide (MOTOR / ALLDATA / ShopKey) | `GET/POST/DELETE /api/integrations/labor-guide`, `POST .../search`, `POST .../manual` | Book providers when connected. If none connected, search auto-falls back to a labeled **web estimate — not book time** via `LABOR_WEB_SEARCH_API_KEY` (Brave). Manual entry always works. ALLDATA/ShopKey adapters are recognized but not live yet |
| QuickBooks Online | `GET/DELETE /api/integrations/quickbooks`, `POST .../connect`, `POST .../callback`, `POST .../sync` | Create an Intuit Developer app; set `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` Worker secrets; shops complete OAuth |

Repair-order flow helpers live in `src/modules/repair-order-flow.js` (inspection → estimate → customer approval link via existing `/api/document-links` + SMS/email messaging → RO → invoice → Stripe payment).

### Apply D1 migrations (when you are ready to deploy)

```bash
# Local only (does not touch production):
npm run db:migrate:local

# Production (owner action — not run by this branch work):
# npm run db:migrate:remote
# npm run deploy:worker
# npm run deploy:pages
```

Migration `worker/migrations/0008_repair_flow_integrations.sql` adds `oauth_states` and `integration_sync_log` for QuickBooks idempotency.

## Release Process

1. Merge reviewed PRs to `main`.
2. Confirm baseline CI (`.github/workflows/ci.yml`) and target workflow(s) pass.
3. Deploy by target workflow (Pages/Worker/R2/Android/Windows).
4. Run smoke checks (see `docs/OPERATIONS.md`) and verify `/api/healthz`.
5. Publish/verify target artifacts (APK, Windows installer) when applicable.

### Flash-drive demo (Windows 10/11 x64)

The **Windows desktop release** workflow builds a separate `shopcrank-usb-demo`
artifact on pull requests, pushes to `main`, and manual runs. Main-branch pushes
also attach `ShopCrank-Demo-USB-1.0.0.zip` (version follows `package.json`) to the
[desktop release](https://github.com/tinytim3271-wq/cloudflare/releases/tag/desktop-v1.0.0).
The normal installer and online ZIP remain unchanged.

1. Download the demo ZIP and **extract the entire ZIP** into a folder on a
   writable flash drive (not just the EXE).
2. Run **Shop Crank Demo.exe** from that folder; no install, Node.js, or internet
   connection is needed on the demo computer.
3. Create a local sign-in with a demo email, name, and your own password. No
   email is sent. Explore the existing sample shop records and local workflows.
4. Close the app fully before safely ejecting the drive.

The account, shop records, Chromium profile, and logs stay in **Shop Crank Demo
Data**, beside the executable. Copy the entire folder to move/back up the demo.
To reset, close the app and delete only that data folder. Use sample data only:
shop records on the drive are not encrypted. A read-only drive fails explicitly
rather than falling back to the computer's profile.

The demo blocks network requests and does not support cloud sync, cloud AI,
online payments/messaging, or live vehicle diagnostics. It includes no baked
credentials, signing keys, or native J2534 host. Unsigned apps may be blocked by
organization policy; consult your administrator rather than disabling security.

Build locally with Node 24 and the existing locked dependencies:

```bash
npm ci
npm run build:windows:demo
```

Output: `dist/windows-demo/ShopCrank-Demo-USB-<version>.zip`. The build uses a
temporary offline/portable edition flag and restores the original edition even
if packaging fails. The Windows workflow launches the extracted app, verifies
drive-local storage, and repeats after moving the folder.

Production remains deployed by `.github/workflows/cloudflare-pages.yml` after
merge to `main` (or a manual main-branch run): D1 migrations, Worker, then Pages.
Deployment requires configured Cloudflare credentials; the USB demo does not.
R2 publishing additionally requires a valid token with bucket write access;
GitHub Release downloads remain available if optional R2 publishing fails.

## Verification Steps

```bash
npm ci
npm run test --if-present
npm run build --if-present
npm run validate:worker --if-present
```

## Cloudflare provisioning

Create the resources once. The production D1 `database_id` is already set in
`wrangler.jsonc`; only replace it when provisioning a new account or database:

```bash
npx wrangler login
npx wrangler d1 create shopcrank
npx wrangler r2 bucket create shopcrank-files
npx wrangler r2 bucket create shopcrank-files-preview
```

Set Worker secrets interactively:

```bash
npx wrangler secret put INTEGRATION_ENCRYPTION_KEY
npx wrangler secret put DIAGNOSTICS_SIGNING_PRIVATE_KEY
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
npx wrangler secret put ACCESS_ADMIN_EMAILS
npx wrangler secret put AUTH_EMAIL_WEBHOOK
npx wrangler secret put AUTH_EMAIL_WEBHOOK_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put STRIPE_BILLING_WEBHOOK_SECRET
```

`INTEGRATION_ENCRYPTION_KEY` should be a generated high-entropy value.
`DIAGNOSTICS_SIGNING_PRIVATE_KEY` must be a PKCS#8 base64 DER ECDSA P-256 private
key used by `/api/diagnostics/authorize`; without it, authorize returns HTTP 503.
`ACCESS_TEAM_DOMAIN` is the full team domain, such as
`https://example.cloudflareaccess.com`; `ACCESS_AUD` is the Access application
audience. `ACCESS_ADMIN_EMAILS` is a comma-separated bootstrap list of platform
administrators. `AUTH_EMAIL_WEBHOOK` must be configured as a Worker secret
pointing to a trusted transactional-email service that accepts `{ email,
loginUrl, returnTo }`; its optional bearer secret is stored as
`AUTH_EMAIL_WEBHOOK_SECRET`. Login links are never returned by the production
API. `STRIPE_BILLING_WEBHOOK_SECRET` is the signing secret for the SaaS
subscription webhook endpoint.

For Google sign-in, create an OAuth 2.0 Web application in Google Cloud and
register `https://www.shopcrank.com/api/auth/google/callback` as an
authorized redirect URI. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
required; the Worker refuses to start the OAuth flow when either is missing.
The callback validates OAuth state, PKCE, the ID-token signature and claims,
and Google's verified-email flag before issuing a Shop Crank session.

### Fixing email sign-in

Sign-in mail is sent by this Worker. `POST /api/auth/send-login` accepts
`{ email, loginUrl, returnTo }`, checks the bearer secret, and returns HTTP 202
only after Cloudflare Email accepts the message. Its address is:

`https://www.shopcrank.com/api/auth/send-login`

Enable Email Routing for `shopcrank.com`, then deploy `shopcrank-api`. After
that deploy, magic-link sign-in uses the `EMAIL` binding directly. Until then,
point `AUTH_EMAIL_WEBHOOK` at the address above. `Unable to deliver the sign-in
email` means the current webhook did not accept the message.

The guided setup command is:

```bash
npm run setup:email
```

The script explains each step, asks for confirmation before saving anything, and
stores the values as **remote Worker secrets** through Wrangler. Your
administrator needs an **HTTPS** webhook endpoint that accepts Shop Crank's JSON
payload:

```json
{ "email": "customer@example.com", "loginUrl": "https://example.com/api/auth/callback?token=...", "returnTo": "/" }
```

If your webhook needs bearer authentication, the same guided flow can also store
`AUTH_EMAIL_WEBHOOK_SECRET`.

Important:

- **Production sign-in uses remote Worker secrets**, not local `.dev.vars`.
- `.dev.vars` is only for local `wrangler dev` testing on your own machine.
- **Do not enable `AUTH_EXPOSE_LOGIN_LINK=1` in production.** That bypass returns
  the magic sign-in link directly instead of proving email ownership.

After the script saves the secret, deploy the Worker:

```bash
npm run deploy:worker
```

Simple verification:

1. Open your Shop Crank site and visit `/login`.
2. Request a sign-in link with an email address you control.
3. Confirm your webhook receives `{ email, loginUrl, returnTo }`.
4. Confirm the email arrives and that the login link signs you in.

Apply schema and deploy:

```bash
npm run db:migrate:remote
npm run deploy:worker
npm run deploy:pages
```

### Production hostname (`www.shopcrank.com`)

Keep Pages as the hostname owner and the Worker on `/api/*` only. Binding
`shopcrank-api` as a custom domain for the whole hostname conflicts with Pages.

Apply the Cloudflare side from a machine (or Actions job) that already has the
production API token:

```bash
npm run provision:shopcrank-com
```

The script is idempotent. It puts `shopcrank.com` on the same account as
Pages/Workers, attaches Pages `shopcrank-dispatch` as `www.shopcrank.com` (and
the apex so `shopcrank.com/api/*` can 301), binds Worker `shopcrank-api` only to
`www.shopcrank.com/api/*` and `shopcrank.com/api/*`, detaches whole-hostname
Worker domains, enables Email Routing/Sending and `noreply@shopcrank.com`,
creates R2 `shopcrank-files` / `shopcrank-files-preview` when the account still
has the old MechPro bucket names, and copies GitHub-available secrets from
`mechpro-api` onto `shopcrank-api`. Secret *values* cannot be read back from
Cloudflare; names that exist only on `mechpro-api` still need `wrangler secret
put` unless the same values are in the environment.

`.github/workflows/provision-shopcrank-com.yml` runs that command with the
`production` Actions secrets on this change and on `main`.

Google Cloud OAuth cannot be updated with a Cloudflare token. On the OAuth 2.0
Web client, set authorized JavaScript origin `https://www.shopcrank.com` and
redirect `https://www.shopcrank.com/api/auth/google/callback`.

If the zone is newly created, point the registrar at the nameservers printed by
the provision report, then re-run the script after the zone is active.

Do not put Cloudflare Access or Bot Fight Mode / Super Bot Fight Mode in front of
the public hostname. Those challenges return HTTP 403 "Just a moment..." for
`https://www.shopcrank.com/` and `/api/*`, which blocks the PWA and API
clients. Reserve Access for an internal admin hostname. Confirm the Worker route
with `curl -sS https://www.shopcrank.com/api/healthz` — it should return JSON
`{"ok":true,"service":"shopcrank-cloudflare-api"}`, not a Cloudflare challenge page.

After an owner signs in with a magic-link from `/login`, create shops in
**Platform Administration**. Account creation maps the owner's email to the
shop; adding or editing an employee synchronizes that employee's email and role
into D1.

For local Worker API development only, copy `.dev.vars.example` to an ignored
`.dev.vars` and fill in secrets:

```bash
cp .dev.vars.example .dev.vars
```

Then send `X-ShopCrank-Dev-Email` (and optionally `X-ShopCrank-Dev-Name`) on local
API requests. Never enable `DEV_AUTH_BYPASS` in production.

## API compatibility

The Worker preserves these routes:

- `/api/auth/session`
- `/api/entities/{type}[/{id}]`
- `/api/vehicles/decode/{vin}`
- `/api/diagnostics/coverage[/bundle]`, `/audit`, `/authorize`
- `/api/onboarding/start`, `/api/payroll/sync`, `/api/tax-report`
- `/api/ai/assistant`
- `/api/files/presign-upload`, `/upload`, `/presign-download`, `/object`
- `/api/payments/checkout-session`, `/api/payments/webhook/{shopId}`
- `/api/subscription/entitlement`
- `/api/agentphone/configure`, `/api/agentphone/webhook/{shopId}`
- `/api/admin/accounts` and account status/credit operations

The historical “presign” endpoints now return short Worker URLs backed by R2.
They intentionally do not expose R2 credentials. Webhook and provider secrets
are encrypted with AES-GCM before storage in D1. A platform administrator can
configure Stripe with:

```http
POST /api/admin/accounts/{shopId}/integrations/stripe
Content-Type: application/json

{"secretKey":"sk_live_...","webhookSecret":"whsec_..."}
```

Register `/api/payments/webhook/{shopId}` in Stripe. Registering AgentPhone from
the Settings screen stores its returned signing secret the same way.

## CI/CD

`.github/workflows/cloudflare-pages.yml` validates the web bundle and Worker,
applies D1 migrations, deploys the Worker, and publishes Pages on `main`.
`.github/workflows/provision-shopcrank-com.yml` attaches `www.shopcrank.com` on
the same account (Pages custom domain + Worker `/api/*` routes only).
Configure these **Actions** credentials for the publish job. The job targets the
`production` environment, so environment secrets with the same names override
repository secrets:

- secret: `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, R2, and Pages edit)
- secret: `CLOUDFLARE_ACCOUNT_ID` (`0c31efca6f8739ca301b222f3d68cff4`)
- variables: optional `CLOUDFLARE_DEPLOY_ENABLED=false` to skip publish,
  `CLOUDFLARE_D1_DATABASE_ID`, optional `CLOUDFLARE_PAGES_PROJECT`, and optional
  `CLOUDFLARE_ALLOWED_ORIGINS`

Publish runs on pushes to `main` and on manual **Run workflow** when
`CLOUDFLARE_API_TOKEN` is set, unless `CLOUDFLARE_DEPLOY_ENABLED` is `false`.
If the token is missing, validate still runs and publish is skipped instead of
failing the workflow. Worker runtime secrets are configured with
`wrangler secret put`, not GitHub variables. The Windows workflow publishes
installers to the configured `CLOUDFLARE_R2_BUCKET` when the same token is set.

Cloudflare API errors `10000` or `9109` mean the configured token is invalid or
lacks access to the account. Rotate both Actions secrets above in the scope
consumed by the `production` job; do not copy an OAuth token from a developer
machine into GitHub. Until CI is rotated, an account owner with an existing
Wrangler OAuth login can deploy from the repository root:

```bash
npm ci
npm run build:web
npm run db:migrate:remote
npm run deploy:worker
npm run deploy:pages
```

## Desktop and mobile

```bash
npm run sync                 # rebuild and sync Capacitor Android
npm run build:windows        # .NET J2534 host + Electron NSIS installer
```

The Windows J2534 native host is under `diagnostics/j2534-service/`. The optional
Python voice-intake sidecar is under `diagnostics/voice-service/`.
The packaged desktop shell remains local-first and does not bypass Cloudflare
Access. Use the hosted PWA for authenticated cloud synchronization.

## OEM diagnostics & programming

The OEM diagnostics module supports vehicle identification, DTC read/clear,
immobilizer key programming (add key, all-keys-lost, program remote, erase), and
UDS module reflash. Every mutating procedure is gated by a **capability token**:

1. The client calls `POST /api/diagnostics/authorize` with `{ vin, procedure, mode }`.
2. The Worker signs an **ECDSA P-256** token (private key = `DIAGNOSTICS_SIGNING_PRIVATE_KEY`)
   scoped to that procedure/VIN/shop/mode, and records an authorization audit row.
3. The J2534 host verifies the token with the **public key only** and executes
   the UDS sequence (SecurityAccess `0x27`, RoutineControl `0x31`, or
   RequestDownload/TransferData/RequestTransferExit `0x34/0x36/0x37`). Tokens are
   single-use and short-lived.

Modes:

- `simulate` — drives the built-in bench simulator (Node host). Always available;
  ideal for training and CI. No OEM credentials required.
- `live` — drives real hardware through the .NET host. Each shop connects its
  **own** vehicle-security (AutoAuth) login, which is what unlocks live
  immobilizer/programming/flash for that shop:
  - `GET /api/diagnostics/autoauth` — connection status (no secrets returned).
  - `POST /api/diagnostics/autoauth` — connect `{ provider, accountId, apiKey }`
    (shop admin only; credentials encrypted at rest in D1, per-shop).
  - `DELETE /api/diagnostics/autoauth` — disconnect.

  Until the shop is connected, live authorization returns `501`. Live execution
  also requires a licensed `ISecurityAccessProvider`. Shop Crank does **not** bundle
  or bypass OEM security-gateway seed/key algorithms; without a real provider,
  live SecurityAccess fails closed.

Signing keys are provisioned per `diagnostics/keys/README.md` (Worker secret for
the private key; public key shipped to hosts). Local dev keys are generated by
`.cursor/install.sh`.

## Validation

```bash
npm run test:config
npm run test:worker
npm run validate:worker
npm run validate
```

`wrangler deploy --dry-run` validates Worker bundling without changing remote
resources. Remote Access policy behavior, D1 migrations, R2 writes, AI
inference, and webhooks still require a configured Cloudflare account.


