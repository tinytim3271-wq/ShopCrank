# LIMITATIONS — what this archive is NOT

Compiled 2026-09-28 03:58 CT. Honest gaps:

1. **Cursor IDE full assistant transcripts are not fully dumped.** User turns from 14 Shop Crank/cloudflare IDE chats are in `09-…` / `cursor-ide-user-turns/`. Raw jsonl (with tool spam) remains on Lees_computer; Composer `store.db` bodies were not fully decoded beyond prompt_history + string hits.

2. **No per-message timestamps inside Timothy’s Grok jsonl.** Dates are inferred from memory logs (2026-08-29, 2026-09-01, 2026-09-12), inventory report header, and Cloudflare session timing. Box file mtimes are all 2026-09-22 06:02 CT (bulk copy), so mtime is not conversation time.

3. **Tool spam / internal reasoning omitted by design.** Cloud agent and executor transcripts contain hundreds of tool calls; archives prefer final reports + major status updates + Timothy user/assistant spoken turns.

4. **Tamara text chat has no Shop Crank thread.** Only a brief voice DNS CNAME mention (2026-09-26).

5. **Timothy has no voice-calls directory** under his agent folder.

6. **GitHub PR merge/CI final state after the archived turns is not re-verified here.** Links and status are as stated in the transcripts (PR #9 shop OS; PR #21 CF token diagnostics; local Wrangler deploy reported live).

7. **Donor repo `reliable-shop-management1` 404 on GitHub** was reported by the cloud agent; local clone inventory still described it on Lees_computer at inventory time.

8. **Two product trees:** AWS-oriented `tinytim3271-wq/Shop Crank` (PR #9) vs Cloudflare Worker/D1 `tinytim3271-wq/cloudflare` (Pages `shopcrank-dispatch`). Transcripts show both; they are not the same codebase.

9. **Secrets:** Archive quotes public account id / domain / healthz from assistant messages already spoken to the user. No new credentials were extracted beyond what those messages contain.
