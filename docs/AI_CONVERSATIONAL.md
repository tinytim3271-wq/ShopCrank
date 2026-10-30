# ShopCrank conversational AI

ShopCrank's primary shop-reasoning path is Anthropic Claude. Sonnet handles normal shop questions and Opus is available for explicit or heuristic escalation of difficult diagnostics. Deepgram Voice Agent provides speech-to-text and text-to-speech while using the same Anthropic account as its BYO thinking backend.

`AI_ENABLED` is `1` in `wrangler.jsonc`. Text assistant turns are routed in this order:

1. **The shop's own Anthropic key** (paid upgrade, see below). Claude answers with the shop's key, so Anthropic bills the shop directly and ShopCrank records no provider cost for those turns.
2. **The platform `ANTHROPIC_API_KEY` secret**, only if a platform admin sets it. This is an optional platform-wide override: ShopCrank then pays Anthropic for every shop that has no key of its own. Leave it unset to keep the default below.
3. **Cloudflare Workers AI** (the included default): the `AI` binding with model `WORKERS_AI_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). It receives the 40 most recently updated shop records as read-only context, cannot call tools, and never prepares estimate drafts.

If a Claude call fails, the turn is answered by Workers AI instead. When the shop's own key is the problem (rejected, no permission, out of credits, model not available), the key is flagged in `shop_ai_settings` and the response carries a `notice` telling the shop to check its key in Shop settings > AI; temporary Anthropic outages fall back with a softer notice and do not flag the key. Voice (Deepgram) is unchanged and still requires both platform provider secrets. Set `AI_ENABLED` to `0` to turn all AI endpoints off.

## Per-shop Anthropic key (paid upgrade)

Shop owners and admins can add their own Anthropic API key in **Shop settings > AI** (`GET/PUT/DELETE /api/settings/ai`).

- Saving runs a one-token Messages call with the key; invalid, unauthorized, or out-of-credit keys are rejected with a clear message and nothing is stored.
- The key is AES-GCM encrypted with the existing `INTEGRATION_ENCRYPTION_KEY` Worker secret and stored in D1 table `shop_ai_settings` (migration `0009_shop_ai_settings.sql`). Only the last 4 characters are kept in clear; the API only ever returns the masked form (`••••1234`).
- Other roles can read the status ("Using Cloudflare AI (included)" or "Using Claude with your key ••••1234") but cannot change it.
- Default Claude model for shop keys: `SHOP_ANTHROPIC_MODEL` (falls back to `ANTHROPIC_SONNET_MODEL`, then `claude-sonnet-5`). An optional per-shop `model` can be sent with the key.
- Until migration 0009 is applied, status reads report the included AI and saving a key returns 503; assistant answers are unaffected.
## Configuration

Never commit provider keys. Configure production secrets with Wrangler:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DEEPGRAM_API_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and replace its placeholders locally. Without an Anthropic key, `wrangler dev` runs the Workers AI fallback against your Cloudflare account (requires `wrangler login`). `.dev.vars` is gitignored.

The non-secret model settings are:

- `ANTHROPIC_SONNET_MODEL` (default `claude-sonnet-5`)
- `SHOP_ANTHROPIC_MODEL` (default Claude model for shops using their own key; defaults to `ANTHROPIC_SONNET_MODEL`)
- `ANTHROPIC_OPUS_MODEL` (default `claude-opus-5`)
- `ANTHROPIC_MAX_TOKENS` (optional; bounded to 256–4096)
- `DEEPGRAM_LISTEN_MODEL` (default `nova-3`)
- `DEEPGRAM_SPEAK_MODEL` (default `flux-kit-en`)

Use model environment variables to pin a dated provider model when release control requires it. OpenAI Live with a strong GPT backend and Gemini Pro with Gemini Live or Deepgram are supported architecture alternatives, but they are intentionally not wired as defaults. Do not replace the primary reasoning model with a small/cheap model or a Workers AI Llama model.

## Text API

`POST /api/ai/assistant` uses the same cookie, Cloudflare Access, and shop-role authorization as the existing ShopCrank APIs. Roles `admin`, `office`, `service_writer`, and `technician` may call it. The existing web assistant already uses this endpoint.

Request:

```json
{
  "message": "Explain the next tests for this intermittent CAN fault and check the open job.",
  "history": [],
  "model": "sonnet",
  "autoEscalate": true,
  "sessionId": "optional-session-id"
}
```

`model` accepts `sonnet` (default) or `opus`. With `autoEscalate: true`, the routing helper selects Opus only when multiple hard-diagnostic signals are present. The JSON response includes `model`, `modelFamily`, `routingReason`, `sessionId`, and token usage.

Each chat is assigned to a tenant-namespaced Durable Object. Send the returned `sessionId` on the next turn to continue server-owned history. Existing clients that send `history` remain compatible: it seeds a new session's history, after which the Durable Object retains the last 20 user/assistant messages.

For local testing with the development auth bypass:

```sh
npm run db:migrate:local
npm run dev:worker

curl -sS http://127.0.0.1:8787/api/ai/assistant \
  -H 'Content-Type: application/json' \
  -H 'X-ShopCrank-Dev-Email: admin@example.com' \
  --data '{"message":"Find estimate EST-100 and explain what is still unknown.","model":"sonnet"}'
```

Claude receives read-only tools for jobs, estimates, invoices, customers, and parts/inventory. Every query includes the authenticated `shop_id`; the model cannot select another tenant. The system prompt requires detailed explanations, forbids unsupported certainty, and directs the model to ask for missing records or diagnostic evidence.

## Voice WebSocket

### Front Desk and Tech Assistant separation

Grok phone calls and receptionist rehearsals use `front_desk`; ordinary in-app
voice uses `tech_assistant`. The client sends the same persona when minting a
voice secret and executing each tool. Server-side persona and role checks apply
independently of the model's tool list. Front Desk tools never expose accounting
or technical shop records. Caller vehicle status is scoped to the uniquely
verified customer's ID, not another customer's matching name.

The Front Desk questionnaire controls public pricing; its answers override
onboarding intake, which overrides profile defaults. Labor rates are disclosed
only when explicitly published. Callback messages are saved to the staff-visible
call history and configured staff are notified (SMS remains subject to go-live).
Knowledge documents are reference data, with permission-scoped retrieval and a
cumulative bounded PDF extraction budget; website refresh selection filters due
sources before applying its batch limit.

Connect an authenticated WebSocket client to:

```text
wss://<worker-host>/api/ai/voice/session
```

The Worker authenticates the user first, assigns a unique Durable Object session, and opens the upstream Deepgram Voice Agent connection server-side. Neither the Deepgram key nor the Anthropic key is sent to the browser. The Durable Object sends Deepgram a BYO Anthropic configuration with the ShopCrank accuracy prompt and a bounded, read-only snapshot of the authenticated shop.

Client audio is raw `linear16` mono at 16 kHz. Returned audio is raw `linear16` mono at 24 kHz. Deepgram JSON events and binary audio are relayed unchanged. A browser voice UI is a follow-up; the current UI continues to use text chat.

The initial voice snapshot is intentionally read-only. Live voice function endpoints for refreshing a record mid-call are a follow-up; until then, the voice prompt must say when the snapshot is incomplete or stale rather than guessing.

## Usage and pass-through billing

Migration `0005_ai_usage_events.sql` records each completed turn/session with:

- tenant and channel: `shop_id`, `user_id`, `text|voice`
- provider and model
- Anthropic input/output tokens for text
- uploaded 16 kHz audio seconds for Deepgram voice
- `provider_cost_usd` and `billed_usd`
- routing/metering metadata and timestamp

Set these non-secret variables to the shop's current provider contract rates:

```text
ANTHROPIC_SONNET_INPUT_USD_PER_MTOK
ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK
ANTHROPIC_OPUS_INPUT_USD_PER_MTOK
ANTHROPIC_OPUS_OUTPUT_USD_PER_MTOK
DEEPGRAM_VOICE_USD_PER_MINUTE
AI_BILLING_MARKUP_MULTIPLIER
```

If a rate or markup is absent, the corresponding cost remains `NULL` rather than inventing a price. This preserves usage for later reconciliation without creating inaccurate invoices. Voice duration is measured from client audio bytes. Deepgram's BYO flow does not expose Anthropic token usage on its live socket, so provider usage reconciliation should be added before automated voice invoicing.

## Validation

```sh
npm run test:worker
npm run validate:worker
```

`validate:worker` runs the Worker tests and a Wrangler deployment dry-run. It does not deploy or upload secrets.
