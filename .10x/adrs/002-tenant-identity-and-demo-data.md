# ADR-002: New-shop identity and demo data scope

**Status:** Accepted · **Date:** 2026-10-20 · **Feature:** p0-blockers · **Author:** 10x-Team (Architect + Staff Engineer)

## Context
The client starts every session from a hardcoded seed: demo work orders, customers, invoices, expenses, and appointments, plus a shop profile of "Your Car Guy, 100 Demo Street, 555-0100, /assets/reliable-logo.jpg". For a new cloud shop:
- The canned-menu seeding calls `saveProfilePatch`, which merges the demo defaults and PUTs them to the shop's real `shopsettings/profile`.
- The demo records stay on screen because the cleanup prompt relies on a server count that is always 0.
The shop name typed at signup is stored in `shops`/`accounts` but never reaches the profile.

## Decision
1. **Demo records are a local-demo feature only.** In cloud sessions (anything that isn't a local shell or the offline desktop edition), `load()` starts with the sample collections empty. Localhost and the USB demo keep the samples.
2. **Neutral profile defaults.** Default shop name, phone, address, and logo are blank. Display falls back to `shopDisplayName()`, which is the profile name or "Your shop". The hardcoded "Your Car Guy" strings are removed. Messaging defaults to disabled with no endpoint.
3. **`saveProfilePatch` saves only stored fields plus the patch**, never defaults.
4. **The server seeds `shopsettings/profile`** with the signup shop name when it creates a shop.
5. **Migration 0015** repairs profiles already polluted with the exact demo address/phone: it sets the name from `shops.name` and blanks the phone, address, and the Reliable logo.

## Alternatives Considered
| Alternative | Pros | Cons | Why not |
|---|---|---|---|
| Make the onboarding cleanup prompt count local samples | Small | New shops still start polluted and must click through; profile still pushed | Treats the symptom |
| Push demo data to the cloud and rely on server cleanup | Reuses existing cleanup endpoint | Writes fake records into real tenants | Wrong by design |
| Keep demo defaults; only fix the push | Minimal | Printouts for shops with no saved profile still show a fake business | Leaves blocker 4 half-fixed |

## Consequences
- Positive: a new shop sees an empty, correctly named workspace; invoices carry its own identity.
- Negative: cloud demos no longer show sample data (use localhost or the USB demo for sales demos).
- Risks: migration 0015 rewrites production rows. It only matches the exact demo address and phone strings, and leaves every other profile untouched.
