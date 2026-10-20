# SDE: market-readiness (2026-10-20)

Follows p0-blockers. One commit per area on `fix/market-readiness`.

| Area | What changed | Tests |
|---|---|---|
| Sales tax (ADR-003) | `estimate-workflow.js`: tax policy on each estimate, `isLineTaxable`, `taxableSubtotal`, proportional discounts; Tax settings toggles; invoices, tax report, QuickBooks and AI pricing use the taxable base | `src/modules/tax-policy.test.mjs`, `worker/test/domain.test.mjs` |
| Security | `worker/src/routes/files.mjs` single file handler with upload type allowlist and safe serving; `enforceSignInRateLimit` + migration 0016; sign-in confirm page (GET shows, POST spends; Origin-checked) | `worker/test/auth-hardening.test.mjs`, `auth.test.mjs` |
| Turnstile | `verifyTurnstile` + `/api/auth/config`; `assets/turnstile-client.js` on /signup, /login and the in-app sign-in | `worker/test/turnstile.test.mjs` |
| Deploy gate | `scripts/smoke/browser-smoke.mjs`, `scripts/dev-worker-local.mjs`, workflow changes, ESLint guard on legacy runtime, safe `npm start` | smoke 10/10 |
| Usability | intake-wizard (email optional, photo waiver, part lines, live total), receivables KPIs, assistant pause button attribute fix, live offline pill, J2534 bridge only on localhost, Help overlap + login footnote CSS, `cloud` icon, completion toast, closeout date, add-vendor/inventory click handlers | `intake-wizard.test.mjs`, targeted browser checks |
| Hygiene | removed `r.text()).then(console.log)`, `_tmp_stripe_scan.txt`, `assets/index-*`, `bun.lock`, `mechpro-*` screenshots/icon | — |

Verification: lint, 275 module/license, 281 Worker, config, J2534, wrangler dry-run, fresh-D1 migrations, smoke 10/10, and browser checks for each usability fix.

Notes:
- Pre-existing, not changed: intake suggests both "Conventional" and "Full Synthetic" oil change lines for an "Oil change" concern; remove one with the × button.
- `.gitattributes` was not added: the repo stores CRLF blobs, and normalizing would rewrite every file.
