# MechPro Cursor Agent Handoff Brief

**Owner:** Timothy Alderman (Lee)  
**Compiled:** 2026-09-28 ~04:00 America/Chicago  
**Purpose:** Paste this into a fresh Cursor agent so it can continue MechPro **without re-deriving** context, and **without rewriting working code**. Preserve every bit of hard work already done.

**How to use:** Open Cursor on the primary repo you are extending (`tinytim3271-wq/MechPro` and/or `tinytim3271-wq/cloudflare`), paste this brief, then open the sibling files listed under **Artifact inventory**.

---

## 0. Non-negotiables

1. **Do not rewrite working systems.** Start from current repos + open PRs. Layer features on top.
2. **Two product trees exist** (do not conflate them):
   - **AWS MechPro:** `https://github.com/tinytim3271-wq/MechPro` — Cognito / Lambda / Aurora / CDK. Shop OS PR #9.
   - **Cloudflare Dispatch:** `https://github.com/tinytim3271-wq/cloudflare` — Pages + Worker + D1 + R2 + Workers AI. Live at `www.yourcarguy806.com`. PR #21 is CI diagnostics only.
3. **No immobilizer bypass, key cloning, rolling-code attacks, FRP/theft unlock tools.** Key programming must require a signed repair order (RO).
4. **Do not invent secrets.** Rotate tokens yourself; never paste live keys into chat.
5. **Prefer local Wrangler deploy** until GitHub `CLOUDFLARE_API_TOKEN` is rotated.

---

## 1. Context — product vision

Timothy wants **one all-encompassing mechanic shop OS** (“one-stop shop”):

- Shop management (customers, vehicles, ROs/WOs, estimates, invoices, parts/POs, schedule)
- Employees (roster, roles, timeclock, GPS/dispatch)
- Payroll (W-2 / 1099 runs, stubs, year-end, advances)
- OBD scanning (live adapter when possible; simulator labeled when not)
- Authorized key programming (signed RO required)
- AI estimates / diagnostics (alongside OBD, not instead of it)
- Cloud hosting for cloud features
- Desktop / Apple / Android deployments called out historically (Capacitor/Electron often claimed in README but not always present in `package.json`)

**User voice (≈2026-09-01):** combine features across folders into one program: shop management, employee management, payroll, OBD scan, program keys — “best shop management program on the market.” Follow-up: cloud-hosted features on **AWS**. Later (≈2026-09-12): **full deploy to Cloudflare** using the **existing** Cloudflare-wired git (not a new connector).

---

## 2. Repos and local paths

| Role | GitHub | Canonical local path (Lees_computer) | Notes |
|------|--------|--------------------------------------|-------|
| Primary AWS shop OS | `https://github.com/tinytim3271-wq/MechPro` | `E:\MechPro\MechPro` | Nested repo; outer `E:\MechPro` is empty wrapper |
| Payroll/shop donor | `https://github.com/tinytim3271-wq/reliable-shop-management1` | `C:\Users\secon\source\repos\reliable-shop-management1` | GitHub sometimes 404’d from agents; use local clone |
| Standalone reference | `https://github.com/tinytim3271-wq/reliable-shop-standalone` | `C:\Users\secon\source\repos\reliable-shop-standalone` | Static extract; weak as source of truth |
| Electron shop host | under `tinytim3271-wq` | (see inventory) | Feature donor / host |
| Cloudflare Dispatch (live) | `https://github.com/tinytim3271-wq/cloudflare` | **`C:\Users\secon\source\repos\cloudflare`** | Prefer this checkout over older clones |
| Older CF clone | same remote | `C:\Users\secon\source\repos\tinytim3271-wq\cloudflare` | Dirtier / older HEAD — prefer canonical above |
| CLI scaffold (ignore) | `reliable-shop-management` | `...\tinytim3271-wq\reliable-shop-management` | Scaffold only |
| Suspicious stub (do not port) | — | `...\bypass` | Empty/suspicious Android stub |

**GitHub user:** `tinytim3271-wq`  
**Windows profile:** `C:\Users\secon`  
**Machine name in Grok Bot:** Lees_computer  

---

## 3. Done — what already shipped

### 3.1 MechPro AWS shop OS — Cursor cloud agent `bc-d1104827-55b4-4565-a1d7-0b699a6661e6`

- **URL:** https://cursor.com/agents/bc-d1104827-55b4-4565-a1d7-0b699a6661e6  
- **Branch:** `cursor/shop-os-payroll-obd-keys-61e6`  
- **PR:** https://github.com/tinytim3271-wq/MechPro/pull/9 (~+4925/−163, ~50 files)  
- **Transcript (box):** `/workspace/cloud-agent-transcripts/bc-d1104827-55b4-4565-a1d7-0b699a6661e6.jsonl`  
- **Transcript (PC copy if shipped):** see `MechPro-handoff-attachments\bc-d1104827….jsonl`

**Landed features (do not rebuild from scratch):**

| Area | What landed |
|------|-------------|
| Shop | Expenses (vendors/overhead); inspection templates on RO panel; existing customers/vehicles/ROs/estimates/invoices/parts/schedule kept |
| Employees | Hourly rate, job title, SSN/tax-id last 4, pay address, pay frequency on edit; roster/timeclock/GPS kept |
| Payroll | W-2/1099 runs from clocked hours (OT, federal/SS/Medicare, optional state, advances); stub PDFs; year-end W-2/1099 + YTD. **Tax math = small-shop estimate, not a payroll processor** |
| OBD | Route `/obd` — VIN, DTCs, freeze frame, live data, readiness, clear-codes; simulator labeled; Web Serial ELM327/STN; J2534 unavailable in browser; scans save to vehicle / can open estimate |
| Keys | Route `/keys` — identify/add/program/test **only with signed matching RO**; simulator without licensed programmer; **rejects** immobilizer bypass / cloning / rolling-code |
| AWS | New Aurora tables: `payrollRuns`, `payStubs`, `shopExpenses`, `inspectionTemplates`, `diagnosticSessions`, `keyProgrammingJobs` + org-member pay fields. Apply `aws/db/migrate/002_shop_os.sql` on existing cluster or full `aws/db/schema.sql` on new. Same CDK stack / Cognito auth |
| Tests (agent-reported) | `pnpm test` 33; `pnpm test:convex` 19; build OK; lint follow-up for `prefer-const` in `elm327.ts` |

**Caveat:** Donor `reliable-shop-management1` 404’d remotely; payroll rebuilt from standalone + MechPro timeclock.

### 3.2 Cloudflare — live production deploy (from Lees_computer Wrangler)

- **Repo:** `tinytim3271-wq/cloudflare`  
- **Wrangler identity:** `lee@yourcarguy806.com`  
- **Cloudflare account ID:** `0c31efca6f8739ca301b222f3d68cff4`  
- **Pages project:** `mechpro-dispatch`  
- **Worker:** `mechpro-api` (version id started with `30342afa…` at ship time)  
- **Pages preview URL:** https://b53a8fb8.mechpro-dispatch.pages.dev  
- **Production:** https://www.yourcarguy806.com/ → HTTP 200  
- **Health:** `https://www.yourcarguy806.com/api/healthz` → `{"ok":true,"service":"mechpro-cloudflare-api"}`  
- **D1:** reported current at ship time (`db:migrate:remote` noop)  
- **Stack on this repo:** Pages + Worker + D1 + R2 + Workers AI (**not** the AWS hybrid as production for this app)

### 3.3 Cloudflare CI diagnostics — cloud agent `bc-b544e316-fd41-4655-bcc3-eeb7dcbe263d`

- **URL:** https://cursor.com/agents/bc-b544e316-fd41-4655-bcc3-eeb7dcbe263d  
- **Branch:** `cursor/fix-pages-production-deploy-263d`  
- **PR:** https://github.com/tinytim3271-wq/cloudflare/pull/21 (+28/−3, 2 files) — clearer GH Actions errors when Cloudflare token is bad + rotation docs; checks green  
- **Transcript (box):** `/workspace/cloud-agent-transcripts/bc-b544e316-fd41-4655-bcc3-eeb7dcbe263d.jsonl`

### 3.4 Prior Cursor IDE work (Lees_computer) — do not lose

Large agent transcripts under `%USERPROFILE%\.cursor\projects\`:

| Project folder | Notable | Themes |
|----------------|---------|--------|
| `c-Users-secon-Downloads-MechPro` | `87eb47ba…` Aug 6–10 | Audit/fix; leave Hercules → Amazon; **MechPro 2.0 on AWS** ask; Aikido |
| `e-MechPro` | `46c0ff8b…` Aug 29–30 | Usability/deployability audit; Bedrock; Secrets Manager; Cognito login errors; AWS deploy |
| `c-mechpro` | `3f9c0052…` ~1.97 MB Sep 4–7 | Full audit/fix; CDK/AWS; clearDtcs security; entity mutation fixes |
| `c-mechpro` | `0984f703…` Sep 7–8 | Cloudflare deployability; PWA/Pages fixes; **create cloudflare git copy** |
| OneDrive / source-repos cloudflare | multiple | CF agent-setup; secrets not set; merge 66 commits; audits; **2026-09-28:** “combine and complete the app and then deploy” |
| Composer chats | Repo Auditor / Merge Branches / CF Setup | Same CF arc |

**User-turn extracts (redacted):**  
`C:\Users\secon\Documents\MechPro-handoff\attachments\cursor-ide-user-turns\`  
(and box: `/workspace/mechpro-history/cursor-ide-user-turns/`)

---

## 4. Feature matrix — wanted vs exists vs still missing

Legend: **Done in PR #9 / main spine** · **Exists elsewhere / partial** · **Missing / weak** · **Out of scope**

| Capability | Status | Where / notes |
|------------|--------|---------------|
| Customers / vehicles / VIN / NHTSA | Done (spine) | MechPro |
| ROs, estimates, invoices, parts, POs, schedule | Done (spine) | MechPro |
| Employees, timeclock, GPS | Done (spine) | MechPro |
| AI estimates / DTC-symptom diagnosis / checklists | Done (spine) | MechPro AI pages; not a substitute for live OBD |
| Shop expenses + inspection templates | Done | PR #9 |
| Payroll W-2/1099 + stubs + YTD | Done (v1) | PR #9; estimate-grade tax math; deepen from local `reliable-shop-management1` if needed |
| OBD bay `/obd` (sim + Web Serial) | Done (v1) | PR #9; J2534 still browser-unavailable |
| Key programming `/keys` (RO-gated) | Done (v1) | PR #9; needs licensed programmer path later |
| Live production Dispatch on Cloudflare | Done | Wrangler deploy Sep 12 |
| CI auto-publish to Cloudflare | **Blocked** | Invalid `CLOUDFLARE_API_TOKEN` |
| Merge PR #9 to MechPro `main` | Verify | Confirm merge state before rebasing |
| Merge PR #21 to cloudflare `main` | Verify | Docs/diagnostics only |
| Unify AWS MechPro UI with Cloudflare Dispatch codebase | **Open product decision** | Two backends today; do not silently replace CF Worker/D1 with AWS or vice versa |
| Real QBO sync | Partial | Export dialog exists; not live sync |
| SMS / voice / Expo Bay Floor / richer HR | Donor | `reliable-shop-management1` — port selectively |
| Capacitor / Electron / Apple / Android | Gaps | Often README-claimed; verify folders/scripts before marketing |
| Immobilezer bypass / FRP unlock | **Out of scope** | Never port `bypass` or FRP consulting plans into shop OS |

---

## 5. Blockers (exact)

1. **GitHub Actions cannot publish Cloudflare:** repo secret `CLOUDFLARE_API_TOKEN` is **invalid** (API errors ~10000/9109).  
   - **Fix:** Create a new Cloudflare API token with Pages + Workers + D1 + Account read permissions for account **`0c31efca6f8739ca301b222f3d68cff4`**.  
   - Set secret `CLOUDFLARE_API_TOKEN` on `tinytim3271-wq/cloudflare`.  
   - Set `CLOUDFLARE_ACCOUNT_ID=0c31efca6f8739ca301b222f3d68cff4` in the **production** Actions environment (per PR #21 notes).  
   - Until then: deploy with local Wrangler as `lee@yourcarguy806.com`.
2. **Architecture split:** AWS MechPro vs Cloudflare Dispatch — pick explicitly before “combining” further.
3. **Local MechPro tree hygiene (historical):** detached HEAD / dirty tree noted Aug 31 inventory — re-check before large merges.
4. **Secrets hygiene:** Old IDE chats may contain pasted live payment keys — **rotate** any exposed Stripe/AWS keys; never re-echo them.

---

## 6. Accounts / credentials references (no secret values)

| What | Value / how |
|------|-------------|
| GitHub org/user | `tinytim3271-wq` |
| Cloudflare login (Wrangler) | `lee@yourcarguy806.com` |
| Cloudflare account ID | `0c31efca6f8739ca301b222f3d68cff4` |
| Production domain | `https://www.yourcarguy806.com` |
| Pages project | `mechpro-dispatch` |
| Worker name | `mechpro-api` |
| D1 / R2 (from wrangler) | D1 `mechpro`; R2 `mechpro-files` (confirm in `wrangler.jsonc`) |
| AWS | Cognito + Lambda + Aurora via MechPro `aws/` CDK — use existing pools/secrets in Secrets Manager; do not create parallel stacks casually |
| Bedrock | User mentioned permanent Bedrock API for voice AI in IDE chats — wire only if still desired; otherwise leave current path |

---

## 7. Build plan for the next Cursor agent (preserve work)

### Phase A — Orient (read-only, 15–30 min)

1. Open this brief + attachments folder.
2. `gh pr view 9 --repo tinytim3271-wq/MechPro` and `gh pr view 21 --repo tinytim3271-wq/cloudflare` — note merge status.
3. On Lees_computer, confirm canonical checkouts:
   - `E:\MechPro\MechPro`
   - `C:\Users\secon\source\repos\cloudflare`
4. Skim inventory reports (attached) — do not re-inventory unless paths moved.
5. Ask Timothy **only** if unclear: single runtime target for “combine and complete” = **AWS MechPro**, **Cloudflare Dispatch**, or **thin SPA on CF talking to AWS API**.

### Phase B — Stabilize bases (no feature rewrite)

1. If PR #9 unmerged: merge or rebase onto current `main` with conflict resolution favoring PR #9 shop-OS modules.
2. If PR #21 unmerged: merge (safe docs/CI).
3. Apply `002_shop_os.sql` on Aurora if not applied; verify Cognito login (historical “No authority or metadataUrl” bug).
4. Rotate Cloudflare token; re-run GH Actions once; keep Wrangler as backup.

### Phase C — Layer missing depth (only gaps)

Priority order suggested:

1. **Product decision:** which UI is customer-facing production (CF Dispatch vs AWS MechPro SPA).
2. If unifying: port **features**, not whole trees — e.g. bring PR #9 payroll/OBD/keys UX patterns into Dispatch **or** point Dispatch API at AWS — document choice in README.
3. Enrich payroll from local `reliable-shop-management1` (stubs/QBO/advances) **without** deleting PR #9 modules.
4. Harden OBD: better ELM327 error handling; document J2534 desktop host if Electron returns.
5. Harden keys: licensed programmer adapter interface; keep RO authorization gates.
6. Mobile/desktop: only after `package.json` scripts and folders actually exist.
7. CI: green Cloudflare publish + MechPro AWS deploy workflows.

### Phase D — Verify

- MechPro: unit + convex tests; login; create RO; run payroll stub; `/obd` sim; `/keys` rejects without signed RO.
- Cloudflare: `/api/healthz`; Pages load; Wrangler + (after rotation) Actions deploy.
- Never claim “fully ready to market” until Capacitor/Electron claims match the tree.

---

## 8. Artifact inventory — paths and how to access

### On Lees_computer (this handoff package)

| Artifact | Path |
|----------|------|
| **This brief** | `C:\Users\secon\Documents\MechPro-handoff\MECHPRO_CURSOR_HANDOFF.md` |
| Cloud agent transcript MechPro PR #9 | `...\attachments\bc-d1104827-55b4-4565-a1d7-0b699a6661e6.jsonl` |
| Cloud agent transcript CF PR #21 | `...\attachments\bc-b544e316-fd41-4655-bcc3-eeb7dcbe263d.jsonl` |
| Shop inventory report | `...\attachments\02-shop-inventory-executor.md` |
| Cloudflare repo finder | `...\attachments\03-cloudflare-repo-finder.md` |
| Sep 1 + Sep 12 Grok Bot thread extract | `...\attachments\01-timothy-grokbot-mechpro.md` |
| Cloud agent summaries | `...\attachments\04-cloud-agent-shop-os.md`, `05-cloud-agent-cloudflare-deploy.md` |
| Full history INDEX | `...\attachments\INDEX.md` |
| Cursor IDE user-turn extracts | `...\attachments\cursor-ide-user-turns\` |
| Raw Cursor IDE jsonl (originals) | `%USERPROFILE%\.cursor\projects\c-mechpro\agent-transcripts\` (etc.) |

### On Grok Bot computer (if agent can reach)

| Artifact | Path |
|----------|------|
| History archive root | `/workspace/mechpro-history/` |
| Cloud transcripts | `/workspace/cloud-agent-transcripts/` |
| Inventory scratch (if still present) | `/workspace/mechpro-inventory/` |

### Live URLs

- https://github.com/tinytim3271-wq/MechPro/pull/9  
- https://github.com/tinytim3271-wq/cloudflare/pull/21  
- https://www.yourcarguy806.com/  
- https://b53a8fb8.mechpro-dispatch.pages.dev  
- https://cursor.com/agents/bc-d1104827-55b4-4565-a1d7-0b699a6661e6  
- https://cursor.com/agents/bc-b544e316-fd41-4655-bcc3-eeb7dcbe263d  

---

## 9. Embedded thread digests (Sep 1 + Sep 12)

### ≈2026-09-01 — Shop OS + AWS

- User: combine all folder features into one shop OS (management, employees, payroll, OBD, keys).
- Inventory: MechPro primary; rsm1 payroll donor; OBD/keys missing then.
- User: cloud on AWS.
- After GitHub auth: cloud agent `bc-d1104827` → PR #9 shop OS.

### ≈2026-09-12 — Cloudflare deploy

- User: full deploy to Cloudflare.
- Declined Cloudflare **connector**; insisted on **existing** Cloudflare git.
- Found `C:\Users\secon\source\repos\cloudflare` → Pages `mechpro-dispatch`, Worker `mechpro-api`.
- CI token invalid; **local Wrangler** deploy succeeded; live domain healthy.
- Cloud agent `bc-b544e316` → PR #21 token diagnostics.

*(Full dialogue extract: attachment `01-timothy-grokbot-mechpro.md`.)*

---

## 10. Suggested first message for the new Cursor agent

> Read `MECHPRO_CURSOR_HANDOFF.md` and the attachments folder beside it. Do not re-inventory unless paths are missing. Confirm merge state of MechPro PR #9 and cloudflare PR #21. Ask me only which runtime is the “combine and complete” target (AWS MechPro vs Cloudflare Dispatch vs hybrid). Then execute Phase B of the brief. Do not rewrite working payroll/OBD/keys modules from PR #9. Do not implement bypass/FRP. After Cloudflare token rotation, verify GH Actions publish.

---

## 11. Change log for this brief

- 2026-09-28: Initial comprehensive handoff from Grok Bot Timothy after voice call request; includes cloud transcripts, inventories, Grok Sep 1/12 threads, Cursor IDE path index, live deploy facts, token blocker.
