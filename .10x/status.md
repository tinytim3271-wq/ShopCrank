# Status

**Phase:** Delivery prep. All audit recommendations implemented and verified on branch `fix/market-readiness`; PR open to `main`, not merged.
**Date:** 2026-10-20

## Done
- [x] P0 blockers 1–5: payments, forms, payroll, new-shop identity (+ migration 0015), demo data. ADR-001, ADR-002.
- [x] P1 sales tax: per-line taxability and a labor/fees tax setting (Texas default: labor untaxed). ADR-003.
- [x] Security: uploads limited to images/PDF (old files served as downloads), sign-in email rate limit (migration 0016), confirm page for emailed sign-in links, opt-in Turnstile.
- [x] Deploy gate: lint (now incl. legacy guard) + module + license tests + Chromium smoke test before deploy; post-deploy health check fails on real outages; offline `npm run dev:worker`; `npm start` refuses to run the mock server.
- [x] Usability: intake (email optional, photo waiver, part lines, live total, blocked-convert focus), Help button overlap, assistant pause icon, receivables KPIs on Invoices, live offline pill, no J2534 polling on the web, login footnote, completion confirmation, closeout date, vendor record cleanup.
- [x] Hygiene: removed stray files, unused old bundles, old MechPro screenshots, stale bun.lock.

## Verification (2026-10-20)
lint ✓ · 275 front-end/license tests ✓ · 281 Worker tests ✓ · config/J2534 ✓ · wrangler dry-run ✓ · migrations 0001–0016 on fresh D1 ✓ · browser smoke 10/10 ✓ · targeted browser checks for every usability fix ✓

## Owner actions before/after merge
0. Copy `.tmp-workflows/ci.yml` and `.tmp-workflows/cloudflare-pages.yml` into `.github/workflows/` and commit them. Remote tools can't write workflow files, so the CI/deploy half of the deploy gate isn't on the branch yet.
1. Merging deploys to production and runs migrations 0015 (demo-profile repair) and 0016 (rate-limit table).
2. Optional: set `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` Worker secrets to turn on the bot check.
3. Confirm branch protection on `main` requires CI + a review (auto-merge.yml relies on it).
4. ~~Finish the Google OAuth cutover~~ **Done (Oct 21, 2026).** `GOOGLE_REDIRECT_ORIGIN` is `https://www.shopcrank.com`, the live Worker redirects to `https://www.shopcrank.com/api/auth/google/callback`, and `npm run verify:google-oauth` exits 0.
5. After deploy: sign up a throwaway shop and record a payment on production.
6. Set `SUPPORT_EMAIL_FORWARD_TO` to the mailbox that should receive `support@shopcrank.com`, then re-run `npm run provision:shopcrank-com`. Until then support tickets are stored in D1 but no email goes out.

## Domain cutover (Oct 21, 2026)
- Canonical host is `https://www.shopcrank.com`; the apex `shopcrank.com` serves the same site.
- The pre-cutover host `www.yourcarguy806.com` (and its apex) now 301s every URL to the canonical host, path and query preserved.
- The privacy and terms pages no longer name a legacy shop; they describe the ShopCrank product generically.
- `ALLOWED_ORIGINS` and `SUPPORT_EMAIL_*` no longer reference the legacy domain.
