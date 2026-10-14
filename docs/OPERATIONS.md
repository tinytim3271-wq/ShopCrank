# Operations Runbook

## Deploy checklist by target

### Cloudflare Pages (`.github/workflows/cloudflare-pages.yml`)
- Confirm CI passed on the target commit.
- Confirm `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are available in Actions.
- Confirm Pages project name variable is set (or default `shopcrank-dispatch` is intended).
- Run `npm run provision:shopcrank-com` (or the `provision-shopcrank-com` workflow) so `www.shopcrank.com` is a Pages custom domain and the Worker is routed to `/api/*` only.
- Run/verify `npm ci`, `npm run build:web`, and `npm run stage:pages`.
- Validate `/` and `/api/healthz` on `https://www.shopcrank.com` after deployment. Pages serves the UI shell; the Worker handles `/api/*` on the same hostname.

### Cloudflare Worker (`worker/`, `wrangler.jsonc`)
- Confirm `wrangler.jsonc` name is `shopcrank-api`, CORS includes `https://www.shopcrank.com`, and D1/R2 bindings match the production account.
- Confirm Pages custom domain `www.shopcrank.com` and Worker route `www.shopcrank.com/api/*` (not the whole hostname).
- Apply migrations (`npm run db:migrate:remote`) before traffic-sensitive changes.
- Deploy (`npm run deploy:worker`) and verify Worker logs/health.

### Cloudflare R2 (`.github/workflows/deploy-r2.yml`)
- Confirm R2 credentials and bucket variable/secret are configured.
- Confirm upload artifact path is present before upload step.
- Verify object key and retrieval from bucket after upload.

### Android APK (`.github/workflows/android-apk.yml`, `android/`)
- Confirm Node/Java/Android SDK steps are green in workflow.
- Confirm `npm run sync` completed before Gradle build.
- Verify `android/app/build/outputs/apk/debug/app-debug.apk` artifact upload.

### Windows Desktop (`.github/workflows/windows-desktop.yml`, `desktop/`)
- Confirm J2534 host publish artifact exists before installer build.
- Confirm desktop build dependencies installed via `npm ci`.
- Validate generated `.exe` and `.zip` artifacts and release upload step.

## Rollback checklist
- Identify last known good commit/workflow run for affected target.
- Re-run deploy workflow at last known good commit or redeploy prior artifact.
- For Worker regressions, redeploy previous Worker bundle and confirm `/api/healthz`.
- For Pages regressions, redeploy previous staged static assets.
- For R2 object regressions, restore previous object version/key.
- Record rollback timestamp, commit SHA, and incident notes.

## Post-deploy smoke test checklist
- Open `https://www.shopcrank.com/` and confirm the shell loads without console errors.
- Confirm `https://shopcrank.com/` 301s to `https://www.shopcrank.com/`.
- Hit `GET https://www.shopcrank.com/api/healthz` and confirm `{"ok":true,"service":"shopcrank-cloudflare-api"}`.
- Validate one authenticated app flow relevant to the deploy.
- Validate one offline/local-first flow still works.
- Validate platform-specific artifact availability (APK/Windows installer) when released.

## Incident triage basics
- Capture: impact, start time, affected targets (Pages/Worker/R2/Android/Windows), and latest deploy SHA.
- Check GitHub Actions run logs for failing step and first error.
- Check Cloudflare dashboard logs (Worker, Pages, R2 access patterns) for correlated failures.
- Verify required secrets/vars still exist and were not rotated incorrectly.
- Mitigate fast (rollback or feature toggle), then document root cause and follow-up tasks.
