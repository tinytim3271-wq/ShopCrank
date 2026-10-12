# 02 — Shop inventory executor (final report)

**Source:** `/home/box/agent-data/agent-transcripts/sand-subagent-35f99ec1-da1e-4aa8-b4c2-120c10582126/sand-subagent-35f99ec1-da1e-4aa8-b4c2-120c10582126.jsonl`  
**Size:** 762,115 bytes / 190 lines  
**Approx. date:** 2026-08-31 ~11:51 PM – 2026-09-01 ~12:00 AM CT (per report header)  
**Role:** Read-only inventory of Timothy’s shop-software projects on Lees_computer for the parent Grok Bot shop-OS build.

---

## Key conclusions (user-facing)

1. **Primary codebase:** Unify around `E:\Shop Crank\Shop Crank` → `https://github.com/tinytim3271-wq/Shop Crank.git` (Vite/TS, Convex-shaped API, AWS Cognito/Lambda/Aurora).
2. **Best donor for payroll/shop depth:** `reliable-shop-management1` (W-2/1099, QBO, POs, expenses, Diagnostics UX, SMS/voice, Expo Bay Floor, Electron hub).
3. **Do not start from** `reliable-shop-standalone` (static frontend extract) or CLI scaffold `reliable-shop-management`.
4. **Gaps vs ask:** Live OBD and key programming **missing everywhere**; AI DTC/symptom only.
5. **Shop Crank local caveat:** Detached HEAD at `27be9a4` with dirty tree; README electron/cap claims not in `package.json`.

---

## Full final assistant report (verbatim)

# Shop-software inventory (Lees_computer, read-only)

Inventory taken ~11:51 PM–12:00 AM CT, Mon Aug 31 / Tue Sep 1, 2026. No clones, no file edits on the projects. Manifests copied to `/workspace/shopcrank-inventory/` (Shop Crank files staged via `%TEMP%` because CopyToBox cannot read `E:\` directly).

---

## GitHub remotes (full URLs) — critical

| Remote | Local path(s) |
|---|---|
| **https://github.com/tinytim3271-wq/Shop Crank.git** | `E:\Shop Crank\Shop Crank` |
| **https://github.com/tinytim3271-wq/reliable-shop-management1.git** | `C:\Users\secon\source\repos\reliable-shop-management1`, nested clone, copilot worktrees |
| **https://github.com/tinytim3271-wq/reliable-shop-standalone.git** | `C:\Users\secon\source\repos\reliable-shop-standalone`, nested clone |
| **https://github.com/tinytim3271-wq/reliable-shop-management.git** | `C:\Users\secon\source\repos\tinytim3271-wq\reliable-shop-management` (CLI scaffold only) |
| **https://github.com/tinytim3271-wq/uninstall-program.git** | `C:\Users\secon\source\repos\uninstall-program` |

No remotes: `E:\Shop Crank` (outer, empty `main`), `NewRepo`, `AndroidApp1`, `bypass`.

---

## Recommended primary codebase

**Unify around `Shop Crank` (`E:\Shop Crank\Shop Crank` → `https://github.com/tinytim3271-wq/Shop Crank.git`).**

Reasons:
- Matches the intended stack (Vite/TS, Convex-shaped API, AWS Cognito/Lambda/Aurora).
- Full **source** frontend + backend (not a prebuilt extract).
- Most recent product work (HEAD `27be9a4` = `origin/main`; last commits are AWS runtime, Cognito, XSS).
- Already has shop ops + employees + tech pay + AI diagnostics/checklists.

**Port into it from `reliable-shop-management1`** (richest shop-management feature set: W-2/1099 payroll, QBO, POs/vendors/expenses, Diagnostics page, inspection templates, SMS/voice, Expo “Bay Floor” app, Electron hub).

Do **not** start from `reliable-shop-standalone` (frontend is static build only; `api-server/src` cannot rebuild without monorepo packages). Do **not** start from the CLI scaffold `reliable-shop-management`.

Caveat for the cloud agent: Shop Crank working tree is **detached HEAD** at `27be9a4` with a large dirty diff (old PWA/docs/lambda files deleted locally; README claims Capacitor/Electron scripts that are **not** in `package.json` and those folders are absent). `package.json` is still named `shopcrank-aws-cdk`. Use `origin/main` plus the live `src/` + `convex/` + `aws/` tree, not the README’s electron/cap scripts.

---

## Features asked for vs what exists

| Requested | Exists? | Where |
|---|---|---|
| Shop management (customers, vehicles, RO/WO, estimates, invoices, parts, schedule) | **Yes, implemented** | Shop Crank + rsm1 |
| Employee management | **Yes** | Both (Shop Crank roster/GPS/dispatch; rsm1 HR + encrypted SSN + compliance) |
| Payroll | **Partial in Shop Crank** (tech pay records, deductions, timeclock, billable hours). **Fuller in rsm1** (generate payroll, pay stubs PDF, W-2, 1099, YTD, advances/loans) | See pointers below |
| OBD scan (live ELM327 / J2534 / Autel) | **Missing everywhere** | AI DTC/symptom diagnosis only; no adapter/serial/Bluetooth scan code found |
| Key programming | **Missing everywhere** | No key-programming modules |

Diagnostics that **do** exist: typed DTC/symptom → LLM diagnosis; AI diagnostic/repair checklists on ROs; NHTSA VIN/recalls/complaints; photo inspections. None talk to a vehicle ECU.

---

## Per-project inventory

### 1. E:\Shop Crank (outer)

- Git repo, **no remotes**, branch `main`, **zero commits**.
- Contains nested app `Shop Crank\`, `decompressedTemplate\pwa-starter-main` (Microsoft PWA starter), `fetchedTemplate.zip`, BSD license (Lee Alderman).
- Not an app. Ignore except as wrapper.

### 2. E:\Shop Crank\Shop Crank — **PRIMARY**

- Git: `origin` https://github.com/tinytim3271-wq/Shop Crank.git  
  Detached HEAD `27be9a4` (= `origin/main`). Extra remote branches: several `cursor/*` AWS/security, `fix/aikido-security-*`.
- Last 5:  
  `27be9a4` Fix stored XSS in diagnostic and repair checklist print popups (#8)  
  `ab36dfb` Fix index.html: update hardcoded Cognito config to new pool  
  `c8fc397` Fix AWS backend client: replace broken baseUrl with HTTP-polling AwsConvexClient  
  `ab81321` Deploy and stabilize AWS runtime backend  
  `d2cf409` Fix Cognito callback sign-in loop
- README: “Mobile mechanic shop management — repair orders, scheduling, invoicing, AI diagnostics.” Stack: React 19 + Vite + Tailwind/shadcn, AWS (Aurora, Cognito, Lambda, API GW, S3), Bedrock AI, Capacitor + Electron **claimed**.
- `package.json` name `shopcrank-aws-cdk`; scripts `vite build` / `frontend:dev` / `cdk:*`. Deps: convex, react 19, stripe, oidc, leaflet, jspdf, openai, radix, tanstack-query. **No** `dev`/`electron`/`cap` scripts despite README.
- Layout: `src/{pages,components,api,hooks,lib}` · `convex/` · `aws/{db,handlers,infra,runtime}` · `scripts/convex-dev.sh` · PWA `public/`.

**Implemented (file pointers):**
- Customers `src/pages/customers/page.tsx` + `convex/customers.ts`
- Vehicles + VIN `src/pages/vehicles/page.tsx`, `dashboard/_components/VinLookupDialog.tsx`, `convex/vin.ts`, `convex/nhtsa.ts` (recalls/complaints/safety)
- Repair orders / bay board / estimates / inspections / photos / signatures / AI workflow: `src/pages/jobs/` (`BayBoard`, `ROCreateDialog`, `RODetailSheet`, `InspectionPanel`, `ROPhotoPanel`, `SignaturePad`, `AIWorkflowPanel`) + `convex/repairOrders.ts`, `inspections.ts`, `roPhotos.ts`
- Invoices + PDF + QuickBooks **export dialog** (not live QBO sync): `src/pages/invoices/` + `convex/invoices.ts`
- Parts + POs + suppliers: `src/pages/parts/page.tsx`, `convex/parts.ts`, schema `purchaseOrders`/`suppliers`
- Schedule / bookings: `src/pages/schedule/page.tsx`, `book/page.tsx`, `convex/bookings.ts`
- Employees + GPS dispatch: `src/pages/employees/` + `convex/employees.ts`
- Payroll-lite: `convex/payroll.ts` (`getMyPayRecords`, `getTechPayRecords`, `getOrgPaySummary`, `getBillableHoursReport`), `convex/deductions.ts`, tech UI `src/pages/tech/_components/MyPayTab.tsx`
- Timeclock + GPS pings: `convex/timeclock.ts`, `src/pages/tech/_components/ClockGpsTab.tsx`, `src/pages/tracking/page.tsx`
- AI diagnose/estimate/repair guide/phone assistant/RO workflow: `convex/ai.ts`, pages `src/pages/ai/`, `ai-estimate/`
- Customer portal, pay, approve, messaging, marketing, multi-location, import, duplicates, Stripe paywall/admin, PWA
- Auth: Cognito OIDC (`src/pages/auth/Callback.tsx`, `react-oidc-context`)

**Unfinished / stubby:**
- README Capacitor/Electron/iOS/Android folders **absent**
- `package.json` still CDK-named; working tree dirty vs git
- Payroll is tech-pay/deductions, not W-2/1099 generation
- Diagnostics are LLM prompts (model strings like `openai/gpt-5.6-luna`), not a scan tool
- QuickBooks is an export dialog, not a sync integration
- SaaS paywall (`src/pages/paywall/`) vs rsm1’s one-time-purchase model

**Hardware:** none (no ELM327/J2534/Autel). AI checklists *mention* scan-tool steps as text.

Copied: `/workspace/shopcrank-inventory/Shop Crank/{README.md,package.json}`

---

### 3. C:\Users\secon\source\repos\reliable-shop-management1 — **FEATURE DONOR**

- Git: `origin` https://github.com/tinytim3271-wq/reliable-shop-management1.git · branch `main`
- Last 5: `2845e57` Merge feature-completeness-audit; `2fbb48a` feat: full suite green, owner tokens, PWA offline, QBO migrations; more merges.
- pnpm monorepo (`name: workspace`). Product name **Reliable Shop Systems** (internal slug `mechanic-ledger`). One-time-purchase, not SaaS. Hosted (Postgres/GCS/Stripe) **or** desktop Electron + PGlite + Android Capacitor companion.
- Layout: `artifacts/{api-server,mechanic-ledger,mechanic-mobile,license-store,...}` · `lib/{db,api-spec,api-client-react,api-zod,integrations-openai-ai-server}` · `desktop/`

**Implemented (pointers):**
- Shop: customers/vehicles/work orders/estimates/invoices/parts/POs/vendors/appointments/inspections/messages/reports/expenses — `artifacts/api-server/src/routes/*.ts`, pages `artifacts/mechanic-ledger/src/pages/*.tsx`, schema `lib/db/src/schema/`
- **Diagnostics page (AI, not OBD):** `artifacts/mechanic-ledger/src/pages/Diagnostics.tsx` + `POST /ai/diagnose` in `routes/ai.ts`. User types DTCs/symptoms; results push to estimate/WO.
- Employees + payroll: `routes/employees.ts`, `routes/payroll.ts` (`POST /payroll/generate`, `GET /payroll/year-end-report/:year`), pay stubs / W-2 / 1099 PDF, encryption `lib/employeeEncryption.ts`, calc `lib/payrollCalc.ts`. Also mechanic hours/advances/loans (`routes/mechanics.ts`, `timeEntries.ts`, `advances.ts`, `loans.ts`, pages `Payday.tsx`, `Hours.tsx`)
- QBO: schema `qboConnections.ts`, `qboSyncLog.ts`; settings tests `Settings.qboSyncLog.test.tsx`
- Offline AI: Ollama + cloud fallback (`artifacts/api-server/src/lib/llmProvider.ts`, `localLlm.ts`)
- Expo app “Reliable Shop Systems — Bay Floor”: customers, WO, inspections, appointments, assistant (mic), messages, payday, reports — `artifacts/mechanic-mobile/app/`
- Stripe for **customer invoice payments only** (explicitly not an app subscription)

**Unfinished (FEATURE-INDEX is slightly stale; code has more):**
- Index still says GDPR export/anonymize/retention not done; **code has** `/employees/:id/compliance/export|anonymize|delete` and `retention/enforce`
- Index: employee-payroll rate limiting / suspicious-activity workflow still called incomplete (but `guardSuspicious` exists)
- `mechanic-mobile` version `0.0.0`
- No live OBD / key programming

Copied: package.json, FEATURE-INDEX.md, IMPLEMENTATION-SUMMARY.md, replit.md, BUILD.md, Diagnostics.tsx, mechanic-mobile-package.json

### Copilot worktrees of the same repo
`C:\Users\secon\source\repos\copilot-worktrees\reliable-shop-management1\*` — extra branches (e.g. `tinytim3271-wq-full-test-and-fix-all` at `7204571`, PR #34). Same GitHub remote. Use only if `main` is missing a fix; otherwise ignore.

Nested clone `C:\Users\secon\source\repos\tinytim3271-wq\reliable-shop-management1` is an **older** checkout of the same remote (`ee5d2ff`). Prefer `source\repos\reliable-shop-management1`.

---

### 4. C:\Users\secon\source\repos\reliable-shop-standalone

- Git: `origin` https://github.com/tinytim3271-wq/reliable-shop-standalone.git · `master`
- Last 5: `afb9d38` Add Electron desktop-host…; `b6cb383` Extract standalone Reliable Shop Systems app (nested clone also has `b0cdc64 yes`, CodeQL)
- Extraction of rsm1: `api-server/` (prebuilt `dist/index.mjs` + src), **static** `frontend/` (no React source), `migrations/`, `desktop-host/` Electron NSIS installer.
- README: cannot rebuild `api-server/src` without `@workspace/db` etc. Frontend source was not extracted.
- Routes almost match rsm1 but **no** `payroll.ts` / `license.ts` / `store.ts` in this extract.
- Useful as a runnable Windows installer reference, not as a source of truth.

Copied: README.md, api-server/package.json

---

### 5. C:\Users\secon\source\repos\tinytim3271-wq\reliable-shop-management

- Git: https://github.com/tinytim3271-wq/reliable-shop-management.git · branch `copilot/compile-and-build-installable-app`
- Last 5: `fd7bb9d` Fix TS config…; `39bd715` Scaffold TypeScript installable app; `78f4cae` first commit
- CLI hello-world (`src/index.ts` prints “installed and running”). **No shop features.** Ignore.

---

### 6. C:\Users\secon\source\repos\NewRepo

- Git, **no remotes**, `master`, one commit `02fb6a5` Add .gitattributes/.gitignore/README. README is `# NewRepo`. Empty VS template.

### 7. C:\Users\secon\source\repos\AndroidApp1

- **Not a git repo.** Default .NET 10 Android template (`com.companyname.AndroidApp1`). `MainActivity` only `SetContentView`. Unrelated stub.

### 8. C:\Users\secon\source\repos\bypass — **FLAGGED (high level only)**

- **Not a git repo.** .NET 10 Android template named `bypass` / `com.companyname.bypass`.
- `MainActivity` is the default “Hello, Android!” stub. **No vehicle, immobilizer, or exploit logic in source.**
- `AndroidManifest.xml` is **not** a default template: it lists a large set of sensitive permissions (device admin / policy, disable keyguard, dump, diagnostic, account manager, bluetooth admin, background location, etc.).
- Treat as a **suspicious empty stub**, not as a feature source. Do not port, do not extract further.

### 9. C:\Users\secon\source\repos\uninstall-program

- Git: https://github.com/tinytim3271-wq/uninstall-program.git · `main`
- Generic Python “remove all traces of a program” CLI. **Not shop software.** Ignore for the product.

---

## Hardware integrations (all projects)

**None found** for ELM327, J2534, PassThru, Autel, WebSerial, or key programming. Closest: LLM “scan_tool” checklist category (Shop Crank `convex/ai.ts`); rsm1 Diagnostics typed-DTC UI; Android INTERNET/BLUETOOTH_ADMIN only on the empty `bypass` stub.

---

## What the cloud agent should do

1. **Base:** `https://github.com/tinytim3271-wq/Shop Crank.git` (`main` @ `27be9a4`), working tree `src/` + `convex/` + `aws/`.
2. **Port from** `https://github.com/tinytim3271-wq/reliable-shop-management1.git`: Diagnostics page UX, W-2/1099/pay-stub payroll, QBO sync, vendors/POs/expenses, inspection templates, SMS/voice, desktop/offline story if still wanted.
3. **New work (does not exist in any repo):** live OBD adapter session + key-programming product surface — design from scratch; there is no donor code.
4. Skip: outer Shop Crank, NewRepo, AndroidApp1, bypass, uninstall-program, CLI `reliable-shop-management`, standalone (except installer UX notes).
