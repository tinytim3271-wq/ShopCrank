# CTO — [DISCOVERED]
- Stack: vanilla-JS PWA (esbuild bundle of src/ → committed app.js), Cloudflare Pages + Worker + D1 + R2 + Durable Objects + Workers AI; Electron Windows desktop (+ offline USB demo edition); Capacitor Android.
- Architecture: local-first client state with an offline mutation queue, multi-tenant Worker API scoped by shop_id; magic-link + Google OAuth sessions (HttpOnly cookie).
- Core risk: a ~6k-line legacy runtime (src/runtime/legacy.js), with filing-overrides.js injected as a text fragment, carries most UI logic but is excluded from lint and from browser-level tests.
