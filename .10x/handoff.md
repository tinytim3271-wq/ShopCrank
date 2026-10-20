# Handoff (SDE/QA → owner, DevOps)

Branch `fix/market-readiness` carries every audit recommendation; see status.md for the list and verification. A PR to `main` is open; merging deploys.

What DevOps should know:
- The two workflow files are NOT on the branch yet (remote tools can't write .github/workflows). They are in `.tmp-workflows/`; copy them in and commit.
- The deploy validate job now installs Chromium and runs `npm run test:smoke` (about 2–3 minutes). It starts the Worker on local D1/R2, serves `.pages-dist` over HTTPS on a non-loopback hostname, and drives a brand-new shop through signup, intake, work order, invoice, payments, payroll and every module at desktop and phone width.
- Post-deploy smoke checks now fail the run on 5xx/timeouts (403 from bot protection still only warns).
- Migrations 0015 and 0016 apply automatically on deploy.

Next role: PM/Architect. Candidates: Avalara/TaxJar integration for non-Texas shops, retire the filing-overrides fragment (it has drifted from legacy.js), dedupe the two canned oil-change suggestions intake adds for "Oil change".
