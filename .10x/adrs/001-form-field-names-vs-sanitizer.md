# ADR-001: Form field names that survive the HTML sanitizer

**Status:** Accepted · **Date:** 2026-10-20 · **Feature:** p0-blockers · **Author:** 10x-Team (Architect + Staff Engineer)

## Context
Every modal and most screens are rendered through `safeHtml` → DOMPurify 3.4 (since cc3cf13, 2026-10-08). DOMPurify's DOM-clobbering protection (`SANITIZE_DOM`, on by default) deletes any `name`/`id` whose value is a property of `document` or `<form>`. Five field names in the app collide: `name`, `title`, `role`, `method`, `body`. Those inputs reach the browser with no `name`, so `FormData` omits them. That breaks record payment, add/edit customer, employee create/edit, vendors, inventory, inspection templates, group chat, team chat messages, and offline-desktop account creation.

## Decision
1. Templates use non-colliding aliases: `displayName`, `jobTitle`, `accessRole`, `paymentMethod`, `messageBody`.
2. One helper, `readFormValues(form)` in `src/shared/form-fields.js`, replaces every `Object.fromEntries(new FormData(x))`. It maps the aliases back to canonical keys (`name`, `title`, …), so handlers and generic record saves stay unchanged.
3. A unit test scans all `src/` templates for `name=`/`id=` values in a fixture list of document/form property names captured from Chromium. It fails the build if a colliding name is reintroduced.

## Alternatives Considered
| Alternative | Pros | Cons | Why not |
|---|---|---|---|
| `SANITIZE_DOM: false` in DOMPurify | One-line change | Turns off clobbering protection for all user-supplied HTML | Weakens a security control app-wide |
| DOMPurify hook that force-keeps `name` on form controls | Small | Bypasses every later attribute check for those attributes; easy to over-match | Harder to reason about than plain names |
| Rename per form and edit every handler | No helper | ~15 handlers to edit by hand, generic modals store the key as-is | Error-prone; the alias map keeps the stored record shape |

## Consequences
- Positive: all affected forms work again; stored records keep their existing keys; the regression is test-guarded.
- Negative: a new field must use the alias for these five names (the test explains this).
- Risks: a handler that reads a field via `querySelector('[name=name]')` would miss the rename. Grep found none.
