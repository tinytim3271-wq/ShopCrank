# AGENTS.md

## Cursor Cloud specific instructions

This repository has three independent parts:

- **Frontend PWA** (repo root: `index.html`, `app.js`, `styles.css`, `service-worker.js`, `assets/`) — a vanilla-JS, local-first Progressive Web App for shop dispatch and work orders. Cloudflare Pages serves it; seed data persists in `localStorage` (`shopcrank-dispatch-v1`) and cloud synchronization fails gracefully offline.
- **Web/packaging source** (`src/`, root `package.json`, `scripts/`) — edit source under `src/`, then run `npm run build:web` to refresh the committed root `app.js`. `npm run sync` also copies the offline shell into `www/` for the Capacitor Android wrapper in `android/`.
- **Cloudflare backend** (`worker/`, `wrangler.jsonc`) — a Worker API using D1, R2, Workers AI, and Cloudflare Access identity. Run `npm run test:worker`, `npm run db:migrate:local`, and `npm run dev:worker` for local work. Remote deploys require Cloudflare credentials.

### Toolchain / non-obvious gotchas

- Use Node 24, matching `.github/workflows/cloudflare-pages.yml` and `package.json` `engines`. On Cloud Agents, `/exec-daemon/node` is ahead of nvm on `PATH` and is not v24. `.cursor/install.sh` prepends the nvm Node 24 directory and writes `/etc/profile.d/shopcrank-node24.sh` so login shells do the same.
- Android/Capacitor flows require Java 21+; `npm run sync` and `npm run build:android` enforce this via `npm run check:java` (`scripts/require-java21.mjs`).
- `wrangler.jsonc` already contains the production D1 `database_id`. CI may override it with GitHub variable `CLOUDFLARE_D1_DATABASE_ID` when set; leave the committed ID as the source of truth for local/remote CLI deploys.
- Copy `.dev.vars.example` to `.dev.vars` for local Worker secrets (`wrangler dev`). Never commit `.dev.vars`.

### Running the frontend (browser)

Serve the repo root over HTTP (service worker registration is gated on a secure context, and `localhost`/`127.0.0.1` counts as secure), e.g.:

```
python3 -m http.server 3000 --bind 127.0.0.1   # then open http://127.0.0.1:3000/
```

Serving the root still only requires a browser refresh. When editing source under `src/`, run `npm run build:web` first. The service worker caches aggressively; hard-reload or clear the `shopcrank-dispatch-v1` service-worker cache if edits don't appear.

Cloud Agent boots run `.cursor/start.sh`. It serves this PWA at `http://127.0.0.1:3000/` and the offline Worker at `http://127.0.0.1:8787/` through `npm run dev:worker`. Plain `wrangler dev` needs a Cloudflare login because the Workers AI and email bindings are remote; the offline script removes those bindings. Local API calls use `X-ShopCrank-Dev-Email` while `DEV_AUTH_BYPASS=1` is set in the gitignored `.dev.vars`.

### OEM Diagnostics (J2534 / Windows)

- **J2534 native host** lives in `diagnostics/j2534-service/`. Build with .NET 8: `./diagnostics/j2534-service/scripts/publish-win-x64.sh` (or `publish-win-x64.ps1` on Windows). Output: `diagnostics/j2534-service/publish/win-x64/J2534.Host.exe`.
- **Windows installer** bundles that exe via `npm run build:windows` (runs J2534 publish then `electron-builder`). Requires Windows for the final NSIS installer; CI workflow `.github/workflows/windows-desktop.yml` builds on `windows-latest`.
- On Windows with a registered J2534 adapter, Electron prefers `J2534.Host.exe` over the Node simulator (`desktop/diagnostics-bridge.js`).
- **Cloudflare diagnostics API** (`/api/diagnostics/coverage`, `/api/diagnostics/audit`, `/api/diagnostics/authorize`) deploys with the Worker.
- **Programming/flashing** (key programming, module reflash) is gated by ECDSA P-256 capability tokens: the Worker signs with `DIAGNOSTICS_SIGNING_PRIVATE_KEY`; hosts verify with the public key only and fail closed without it. See `diagnostics/keys/README.md` for key provisioning (`.cursor/install.sh` generates local dev keys). `simulate` mode drives the Node bench simulator; `live` mode requires shop AutoAuth credentials + a licensed `ISecurityAccessProvider` (OEM seed/key is never bundled or bypassed).
- The Node simulator is fully testable on Linux: `npm run test:worker` (capability tokens + authorize) and `npm run test:j2534` (SecurityAccess, key programming, and flash sequences). The `.NET` host is Windows-only and not built in CI Linux.
