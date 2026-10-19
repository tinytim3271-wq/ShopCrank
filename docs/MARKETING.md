# ShopCrank commercial plan

Locked public prices. Founding rates are invite-only and do not appear on `/pricing`.

| Plan | Public price | AI phone minutes | Overage | Diagnostics | Who it is for |
|---|---:|---:|---:|---|---|
| Solo | $69/month | 200 | $0.15/min | Simulator | Mobile mechanic |
| Shop | $139/month | 800 | $0.12/min | Simulator | 2–10 person shop |
| Shop Pro | $279/month | 2,500 | $0.10/min | Live OEM + the shop's AutoAuth login | Programming shops |
| Enterprise | $559/month | 10,000 | $0.08/min | Live OEM, up to 25 locations | Chains and fleets |

Annual prepay on any tier is 10 months for 12 (2 months free). Unlimited users on every tier. No per-seat fee.

Founding Member offer is locked for launch: first 50 shops, private link only — Solo $49, Shop $99, Shop Pro $199. Those rates stay while the subscription stays active. The page is `/founding?invite=…`. Do not change N or prices in public posts without updating `FOUNDING_MEMBER_CAP` / `FOUNDING_PLANS` in `worker/src/plans.mjs`.

## What the product actually does

- Dispatch, scheduling, work orders, customers, invoices, and CSV import.
- The in-app assistant drafts estimates from typed or spoken notes. A person confirms the job before it is sold.
- Settings connects an AgentPhone agent. Calls and texts are answered by that assistant. The minute caps above are the commercial allowance.
- Card payments use a Stripe-hosted page. ShopCrank does not store card numbers.
- Solo and Shop authorize the diagnostics simulator. Shop Pro, Enterprise, and Founding Pro authorize live key, immobilizer, and module procedures. Live mode also needs that shop's AutoAuth login and a J2534 pass-thru. OEM seed and key material is not bundled.
- The shop app is an offline-capable PWA. Sign-in is a one-time work-email link.

The shop app stays at `/`. The public offer is `/features` and `/pricing`. A trial is 14 days and does not collect a card on the signup form.

## Launch rules

Do not print founding prices on the public pricing page. Do not advertise live programming on Solo or Shop. Do not say the AI phone files an estimate or programs a key by itself. Payroll numbers in the app are planning figures, not a filed return.

Issue a single-use invite with `npm run issue-invite -- "where you met them"`, apply the printed D1 statement, and send only that `/founding` link.
