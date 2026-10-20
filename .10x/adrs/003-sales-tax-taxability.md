# ADR-003: Line-level sales-tax taxability

**Status:** Accepted · **Date:** 2026-10-20 · **Feature:** sales-tax-labor · **Author:** 10x-Team (Architect + Staff Engineer)

## Context
Every estimate calculator applied the tax rate to the whole subtotal (labor + parts + fees). In Texas, repair labor on motor vehicles isn't taxable. On an itemized invoice only parts are taxed (Comptroller pub. 94-113). So ShopCrank over-collected tax for its home-market customers, and the sales-tax filing report overstated taxable sales. Totals are computed both in the browser and in the Worker (approval re-pricing, document links) through the shared `src/modules/estimate-workflow.js`. Many client paths create estimates.

## Decision
1. **A tax policy travels with each estimate:** `estimate.taxPolicy = { laborTaxable, feesTaxable }`. `calculateEstimate(lines, rate, fees, taxPolicy)` taxes parts always; labor and fees follow the policy. An explicit `line.taxable` true/false overrides the policy for that line. Totals now also return `taxableSubtotal` and `taxPolicy`.
2. **Discounts reduce taxable and non-taxable amounts in proportion.**
3. **The shop setting lives on the Tax settings record:** "Charge sales tax on labor" and "Charge sales tax on shop supplies and fees". If a shop never set them: labor is not taxed when the tax state is TX and is taxed in other states (prior behavior); fees stay taxed.
4. **The browser sets the module's default policy from the shop's settings.** The Worker never sets it, so an estimate without a stored policy (created before this change) re-prices exactly as it was created.
5. Invoices store `taxableSubtotal` and per-line `taxable` flags. QuickBooks sync and the sales-tax report use them.

## Alternatives Considered
| Alternative | Pros | Cons | Why not |
|---|---|---|---|
| Global policy only in the browser | Smallest diff | Worker approval re-pricing would recompute with labor taxed and overwrite the browser total | Totals would disagree |
| Per-line flag stamped on every line at creation | Fully explicit | Dozens of creation paths, and a later settings change wouldn't apply to open estimates | Too many touch points |
| Full jurisdiction tax engine (Avalara/TaxJar) | Correct for every state | Cost and integration time | Later, as an optional integration |

## Consequences
- Positive: Texas shops stop over-collecting. Other states keep today's totals unless the owner changes the setting.
- Negative: two settings the owner must check in states with different rules. The help text says to confirm with a tax professional.
- Risks: estimates created before this change keep labor taxed until edited. The policy is stamped on the next recalculation.
