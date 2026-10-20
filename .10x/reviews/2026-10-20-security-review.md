# Security review: 2026-10-20 (commit 196fa8f)

## Passed (tested live against local Worker + D1/R2)
- Tenant isolation: Shop B can't GET, PUT, or DELETE Shop A's work orders, can't record payments on Shop A's invoices, and can't read Shop A's R2 photos (403 "File key is outside this shop"). B's PUT to the same ID created B's own record.
- Unauthenticated API calls return 401. Session cookie is HttpOnly, Secure, SameSite=Lax. Magic-link tokens are hashed at rest, expire in 15 minutes, and are single-use.
- Entity-level RBAC (`canReadEntity`/`canWriteEntity`, employee redaction) is covered by the Worker tests.
- No real secrets in the tree or git history. The `sk-ant-` strings in worker/test/shop-ai.test.mjs are fake placeholders. Only the SSN last 4 digits are stored.
- The browser CSP blocks the default httpbin messaging endpoint.

## Findings
| Sev | Finding | Fix |
|---|---|---|
| Medium | **Stored HTML served from the app origin.** `PUT /api/files/upload` stores any client-supplied Content-Type, and `GET /api/files/object` serves it back (`text/html` verified). Any user in a shop (e.g. a technician) can plant a page that runs as the owner when opened. | Enforce the image/pdf allowlist on PUT, and set `Content-Disposition: attachment` plus `Content-Security-Policy: sandbox` on file responses. |
| Medium | **No abuse protection on `/api/auth/magic-link`.** Only a per-email resend limit exists; 5 different addresses in a row all returned 200. This allows email bombing and puts the sending reputation of the domain at risk. | Cloudflare WAF rate-limit rule on the path, plus Turnstile on /signup and /login. |
| Medium (usability/security) | **GET `/api/auth/callback` consumes the token.** Corporate link scanners (e.g. Microsoft Safe Links) prefetch links, which can burn the token before the user clicks. (Known pattern; not reproduced here.) | Serve a "Continue to ShopCrank" page that POSTs the token. |
| Low | `npm start` runs `server.mjs`, a mock that returns an admin session (lee@yourcarguy806.com) to any caller. It's bound to 127.0.0.1 now, but `start` is the conventional production command. | Rename to `dev:mock`, and make `start` fail loudly. |
| Low | Messaging default is `enabled: true` with endpoint `https://httpbin.org/post`. | Default to disabled with an empty endpoint. |
