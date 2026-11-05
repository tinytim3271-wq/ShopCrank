# DevOps
- Prod deploy: cloudflare-pages.yml → validate (build, lint, module/license/config/worker tests, smoke, dry-run) → D1 migrate → Worker → secrets → Pages → health checks (fail on outage, warn on 403).
- Local: `npm run dev:worker` runs offline (scripts/dev-worker-local.mjs); `npm run dev:worker:remote` uses remote AI/email.
- Hostnames: `www.shopcrank.com` is canonical, `shopcrank.com` is the apex, and ShopCrank is served on ShopCrank domains only (2026-11-05: the pre-cutover host was handed back to the owner's auto-repair business website). `npm run provision:shopcrank-com` reapplies that state and releases any ShopCrank Worker/Pages binding found on another domain; it never edits another zone's DNS or email.
- Open: confirm branch protection on main; set `SUPPORT_EMAIL_FORWARD_TO` so `support@shopcrank.com` forwards.
