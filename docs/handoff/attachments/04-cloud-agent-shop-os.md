# 04 — Cloud agent: Shop Crank AWS shop OS

**Source:** `/workspace/cloud-agent-transcripts/bc-d1104827-55b4-4565-a1d7-0b699a6661e6.jsonl`  
**Size:** 1,484,542 bytes / 962 lines  
**Agent ID:** `bc-d1104827-55b4-4565-a1d7-0b699a6661e6`  
**URL:** https://cursor.com/agents/bc-d1104827-55b4-4565-a1d7-0b699a6661e6  
**Approx. date:** launched ~2026-09-01 from Timothy Grok Bot chat  
**Outputs:** Branch `cursor/shop-os-payroll-obd-keys-61e6` · PR https://github.com/tinytim3271-wq/Shop Crank/pull/9 (+4925/-163, 50 files)

---

## Launch prompt (summary)

Build Shop Crank into one auto shop OS: shop management + employees/payroll + diagnostics/OBD + authorized key programming. Cloud-hosted features MUST run on AWS. Base repo `tinytim3271-wq/Shop Crank`. Port behavior from `reliable-shop-management1` / reference `reliable-shop-standalone`. Skip bypass/theft tools. Hardware at bay; sessions sync to AWS.

*(Full prompt length: 4719 chars in transcript line 0.)*

---

## Final product report (verbatim)

Shop Crank is now one shop OS on the existing AWS stack: shop ops, employees, payroll, OBD bay, and authorized key programming share one nav and persist through the Lambda → Aurora path.

**Shop.** Customers, vehicles, ROs, estimates, invoices, parts/POs, and schedule stay as they were. Added shop expenses (vendors/overhead) on Payroll, and inspection templates on the RO inspection panel.

**Employees.** Roster, roles, timeclock/GPS unchanged. Employee edit now stores hourly rate, job title, SSN/tax-id last 4, pay address, and pay frequency.

**Payroll.** Generate a W-2/1099 run from clocked hours (overtime, federal/SS/Medicare, optional state rate, advances), download pay-stub PDFs, and view W-2 / 1099 year-end with YTD. Tax math is a small-shop estimate, not a payroll processor.

**OBD bay (`/obd`).** VIN, DTCs, freeze frame, live data, readiness, confirmed clear-codes. Simulator is labeled when no adapter; ELM327/STN use Web Serial; J2534 reports unavailable in the browser. Scans save to the vehicle and can open an estimate. AI Tools stays next to this for symptom/DTC interpretation.

**Key programming (`/keys`).** Identify / add / program / test only when the customer signed the matching RO. Simulator when no licensed programmer. Immobilizer bypass, cloning, and rolling-code attacks are rejected.

**AWS.** New Aurora tables (`payrollRuns`, `payStubs`, `shopExpenses`, `inspectionTemplates`, `diagnosticSessions`, `keyProgrammingJobs`) plus org-member pay fields. Same CDK stack; apply `aws/db/schema.sql` on a new cluster or `aws/db/migrate/002_shop_os.sql` on an existing one. README covers local run and `cdk:deploy`.

Donor `reliable-shop-management1` was not available (404). Payroll/stub behavior came from `reliable-shop-standalone` plus Shop Crank’s timeclock/deductions. QuickBooks stays CSV export. Hardware stays at the bay; sessions and jobs sync to AWS.

**Tests**
- `pnpm test`: 33 passed (payroll calc, RO/invoice totals, diagnostic session, key authorization)
- `pnpm test:convex`: 19 passed (invoice-from-RO, generate payroll + advances, OBD → estimate, key job requires signed RO)
- `pnpm build`: succeeded
- AWS Lambda registry bundled `payroll`, `diagnosticSessions`, `keyJobs`, `expenses` (55 modules). Postgres-backed `pnpm test:aws` was not run here (no Docker)

<TextReference path="/opt/cursor/artifacts/unit_tests.log" start={231} end={238} alt="Unit test summary: 33 passed"></TextReference>
<TextReference path="/opt/cursor/artifacts/convex_tests.log" start={1} end={12} alt="Convex test summary: 19 passed"></TextReference>
<TextReference path="/opt/cursor/artifacts/aws_registry_build.log" start={1} end={20} alt="AWS registry bundle including new shop OS modules"></TextReference>

---

## Follow-up: CI lint fix (verbatim)

The failed **Test** job was lint, not the new payroll/OBD/key tests. ESLint reported `prefer-const` in `parseMode03` (`src/lib/obd/elm327.ts`): the DTC hex buffer was declared with `let` and never reassigned.

That is fixed (`const body`), and the unused OBD `useMemo` deps that triggered a warning are cleaned up. Local `eslint .` is 0 errors; unit tests still pass (33).

A new CI run is in progress on this lint fix. I’ll take the result when it finishes.
