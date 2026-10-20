# DevOps
- Prod deploy: cloudflare-pages.yml → validate (build, lint, module/license/config/worker tests, smoke, dry-run) → D1 migrate → Worker → secrets → Pages → health checks (fail on outage, warn on 403).
- Local: `npm run dev:worker` runs offline (scripts/dev-worker-local.mjs); `npm run dev:worker:remote` uses remote AI/email.
- Open: confirm branch protection on main; Google OAuth cutover.
