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

### Shop onboarding, phone and SMS safety
- Apply `0017_sms_delivery_callbacks.sql`, `0018_onboarding_knowledge_handoff.sql`, and `0019_onboarding_executions.sql` before deploying this onboarding flow. Migration 0017 remains the existing SMS migration.
- `ONBOARDING_LIVE_MODE` defaults to `0`. Plans and executions default to dry-run. Only a platform `super_admin` can provision a shop using `/api/onboarding`; shop admins can read `/api/onboarding/self`.
- For paid steps, POST `/api/onboarding/{shop}/steps/{step}/plan`, then `/approve` with the returned `planHash` and `confirm: "APPROVE"`. `/execute` needs `mode: "live"`, an unexpired matching approval, and `ONBOARDING_LIVE_MODE=1`. The platform flag also gates `calls_go_live` and `sms_go_live`.
- Set master Twilio credentials through Worker secrets (`TWILIO_MASTER_ACCOUNT_SID`, `TWILIO_MASTER_AUTH_TOKEN`), plus `INTEGRATION_ENCRYPTION_KEY` for encrypted shop credentials. Configure `TWILIO_PRIMARY_CUSTOMER_PROFILE_SID` and `ONBOARDING_TEST_CALLER_NUMBER` for the provider-approved onboarding setup. Never put subaccount auth tokens in onboarding state, events, or checkpoints.
- Each live step takes a durable atomic claim before provider requests. Check `onboarding_executions` for the run ID, approved plan hash, sanitized results, and pending request. A running/interrupted or ambiguous request never times out into an automatic retry. An ordinary failed run resumes completed requests only under the same plan hash.
- For a stuck `running`/`reconcile` claim, first verify the original run has stopped and inspect Twilio for the pending request's actual outcome. Reconcile resource IDs, encrypted credentials, and onboarding state before changing the claim. If no resource was created, an operator may clear `pending_key` and mark the claim `failed`; preserve its plan hash and completed results. If a resource exists, record its sanitized result and securely store any credentials before retrying the original plan. Never clear checkpoints or change a partially executed plan merely to retry: this can purchase duplicate resources. Completed provisioning is not automatically replayable.
- Test-call checks require a connected outbound call and a matching inbound caller/number/time window with both Media Stream and xAI `session.updated` evidence for that same call/stream. A call duration or a successful forward alone cannot pass. Live Twilio/xAI and A2P approval still require provider-side verification.
- Before phone go-live, ordinary calls forward to the shop's existing number; the configured test caller can reach the bot. Before SMS go-live, the shared SMS sending boundary blocks **all** real texts for onboarded shops, including staff notifications and automated follow-ups. Shops without onboarding records retain their existing behavior. Voice credential resolution is not SMS-gated.
- The 15:00 UTC follow-up cron remains separate. The 08:00 UTC job also refreshes due knowledge sources and polls pending A2P submissions (polling requires live mode).

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

## Google OAuth cutover
- OAuth Web client lives in GCP project `com-yourcarguy806-mechpr-fc4af` (project number `451228968006`).
- Client id (public): `451228968006-ebcekb6k5etif5qnp43n7hiroo0td6vd.apps.googleusercontent.com`
- Authorized JavaScript origin: `https://www.shopcrank.com`
- Authorized redirect URI: `https://www.shopcrank.com/api/auth/google/callback`
- Worker var `GOOGLE_REDIRECT_ORIGIN` is set to that origin in `wrangler.jsonc`. **Do not deploy the Worker until Google accepts the URI.**
- Verify: `npm run verify:google-oauth` (exits 0 when registered, 1 while still mismatched).
- Then: `npm run deploy:worker`. Cloudflare cannot register Google Cloud OAuth clients.
- Status: registered. The live Worker redirects to
  `https://www.shopcrank.com/api/auth/google/callback` and Google accepts it.

## Legacy host cutover (`www.yourcarguy806.com`)
- The pre-cutover host now 301s every URL to `https://www.shopcrank.com`. The
  legacy zone's wildcard Pages route is gone and the whole host points at
  `shopcrank-api`, which answers with the redirect.
- `npm run provision:shopcrank-com` is idempotent and reapplies this state: it
  detaches the old `mechpro-api` custom domains, drops the wildcard Pages
  route, re-points the legacy host at `shopcrank-api`, and restores the legacy
  DNS records. **DNS edit requires an API token** — a Wrangler OAuth login
  cannot write DNS, so run it from the Actions job or a machine with the token.
- Detaching a Worker custom domain deletes that hostname's DNS record. If the
  legacy host stops resolving, re-run the script; it recreates the records.
- The `shopcrank.com` apex is a proxied CNAME to `shopcrank-dispatch.pages.dev`.
  An A record to a Cloudflare address is rejected with "DNS points to
  prohibited IP", so keep it a CNAME.
- `support@shopcrank.com` needs an Email Routing forward rule. Set
  `SUPPORT_EMAIL_FORWARD_TO` before running the script; otherwise the support
  ticket is stored in D1 but no email is sent.

## Live key programming (AutoAuth unlock)
- Per-shop AutoAuth login is stored encrypted in D1 (`POST /api/diagnostics/autoauth`).
- Platform unlock endpoint is Worker secret `AUTOAUTH_UNLOCK_URL`. When unset, live SecurityAccess returns intentional HTTP 501.
- Set with `npx wrangler secret put AUTOAUTH_UNLOCK_URL` once the licensed unlock partner URL is available. Do not invent a placeholder URL in production.
