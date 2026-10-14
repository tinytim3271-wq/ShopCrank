# v1.1.0 — Gemini-included Assistant Update

This release makes Gemini available by default for every subscription, adds a dynamic assistant/provider header in the UI, and preserves optional bring-your-own-provider flexibility for shops that want to switch to Claude.

## Highlights

- **Gemini included by default** across subscriptions (no extra setup required).
- **Dynamic assistant/provider header** now reflects the active provider state.
- **Optional provider override** in shop settings supports switching to **Claude (Anthropic)** or using a shop Gemini key.
- **Fail-closed + fallback behavior** is preserved for provider/API key issues.

## Database / Migrations

- Added/updated migrations for shop AI provider defaults:
  - `worker/migrations/0010_shop_ai_gemini_provider.sql`
  - `worker/migrations/0011_shop_ai_default_provider_gemini.sql`
- Local migration chain was validated end-to-end after reset.

## Validation

Full validation pipeline completed successfully:

- `npm run validate`
  - web build
  - config checks
  - module test suite
  - worker validation (dry-run)
  - J2534 host-node tests

## Deployment

- Worker deployed from `main` via `npm run deploy:worker`.
- Pages deployed from `main` via `npm run deploy:pages`.
- Deployment URL: https://ed45fe40.shopcrank-dispatch.pages.dev

## Tag

- Release tag pushed: `v1.1.0`

