# DevOps
- Prod deploy: cloudflare-pages.yml → validate (build, lint, module/license/config/worker tests, smoke, dry-run) → D1 migrate → Worker → secrets → Pages → health checks (fail on outage, warn on 403).
- Local: `npm run dev:worker` runs offline (scripts/dev-worker-local.mjs); `npm run dev:worker:remote` uses remote AI/email.
- Hostnames: `www.shopcrank.com` is canonical, `shopcrank.com` is the apex, and the old `www.yourcarguy806.com` 301s to the canonical host. `npm run provision:shopcrank-com` reapplies that state.
- Open: confirm branch protection on main; set `SUPPORT_EMAIL_FORWARD_TO` so `support@shopcrank.com` forwards.
