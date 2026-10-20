# Handoff (QA + Security → Architect / SDE)

The audit is complete. No code was changed. The P0 list for the next role:

1. DOMPurify strips form field names that collide with DOM props (`name`, `title`, `method`, `action`, `role`) in every modal rendered through `showModal → safeHtml`. This breaks Record payment (invoice + work order), Add/Edit customer, Create/Edit employee, vendors, inspection templates, and group chat. Regression since cc3cf13 (2026-10-08). Recommend renaming fields (e.g. `customerName`, `paymentMethod`) and adding a unit test that runs every modal template through the same sanitizer and asserts each FormData key survives. Write ADR-001 first.
2. Payroll TDZ crash: `let state = 0` inside `ytdPayForUser` (src/runtime/filing-overrides.js:322 and legacy.js:4036) shadows the global `state`. Rename it to `stateTax`. Bring both files under ESLint (`no-shadow`).
3. New tenants inherit the demo shop profile ("Your Car Guy", 100 Demo Street, 555-0100, /assets/reliable-logo.jpg). The client PUTs it to /entities/shopsettings/profile on first load. Seed the profile from the server's `shops.name` and the signup data, and remove the hardcoded "Your Car Guy" strings (estimateMessage, accounting heading, messaging/billing defaults).
4. Demo data never clears. `checkOnboardingSamples` relies on a server sample count that is always 0 because samples are local-only. Don't seed demo records for cloud tenants at all, or count local samples on the client.
5. Tax: `calculateEstimate` taxes the whole subtotal. Add a per-line `taxable` flag and a shop setting for labor taxability. Texas doesn't tax repair labor on itemized invoices.

Repro harness used: wrangler dev (local D1/R2) + staged .pages-dist behind an HTTPS proxy on a non-loopback hostname + Playwright. Scripts are described in the QA report.
