# Testing record

This is an honest record of what has been checked and how. "Not verified" means exactly that.

## Automated (`npm test`)

The suite has 111 tests in Vitest, run against fake-indexeddb and jsdom. It covers:

- **Storage:** seeding, export and import round-trips, invalid-import rollback, settings defaults.
- **AI providers:** model parsing; SSE and NDJSON streaming; Ollama errors (not running, 403 CORS, model missing); `think:false`; filtering out embedding models; HTTP-200 error bodies; timeouts; key redaction.
- **Router:** fallback; Free-Only never calls paid models; Offline; Manual has no fallback; vision routing; autopilot paid block; daily cap; disabled providers; unknown models treated as paid.
- **Content:** JSON parsing, the Threads 500-character limit (counted in graphemes), and the claim check (prices, percentages, numbers not in the knowledge base).
- **Media:** pick order (unused tag match → unused → least recently used); import skips `node_modules` and hidden folders; tags from paths.
- **RPA engine (DOM fixtures):** typing preserves emoji and newlines; preflight when logged out, on the wrong account, or acting as a personal profile; the Facebook composer author check never clicks Post; a dry run never clicks Post; feed fingerprint matching and permalinks.
- **RPA orchestrator (fake driver):** preflight failure; confirmed → published; unconfirmed → unknown; error before the click → failed; error after the click → unknown.
- **Queue:** concurrent ticks never post twice; retry backoff 2/10/30 min; unknown → verifying → feed check with no repost; restart recovery; a worker dying mid-publish leads to a feed check; posts more than 2 h late are skipped; only the latest missed slot is posted; minimum gap; 7-day dedupe; cancel; Asia/Jakarta conversion; calendar drag keeps the time of day.
- **Autopilot:** 2 posts/day gives 11:30 and 16:30 WIB for Threads, with Facebook 30 minutes later; pausing plans nothing; planning is idempotent and never creates past slots; claim check fails twice → skip; regenerate once; paid model refused → skip; review window approve/reject; missed slots.
- **Analytics and UI:** stats come only from our own records; the provider card test button; account URL validation.

`npm run typecheck`, `npm run lint` and `npm run build` all pass. A whole-branch review found two double-post paths, a lock that was too short, and a way past the daily cost cap; each was fixed with a test that failed first.

## Live checks

| Date | What | Result |
|------|------|--------|
| 2026-11-09 | Ollama (localhost:11434), via `scripts/check-providers.ts` | OK: 6 chat models (embedding-only `bge-m3` filtered out), 4 with vision. A real streamed chat with `qwen3:8b` returned Indonesian text in about 0.5 s. **Bug found and fixed:** reasoning models returned empty content until `think:false` was sent. |
| 2026-11-09 | OpenRouter, with the user's key (passed through env, not stored) | OK: 461 models, 16 free, 314 vision. A real chat with free `stealth/crouton-alpha` returned Indonesian text. **Bug found and fixed:** HTTP-200 JSON error bodies (upstream 429) were reported as "empty response". |
| 2026-11-09 | NVIDIA | **Not verified:** no key was available. Tested only against recorded response shapes. |
| 2026-11-09 | Content generation end to end (Node, real Ollama `qwen3:8b`) | 3 variations parsed, each 275–339 characters, claim check clean. |
| 2026-11-09 | **Load unpacked** in Chrome for Testing 157 (puppeteer) | The service worker starts and the `queue-tick` alarm is registered. All 11 dashboard pages and the popup render with **no console errors**. The CuciQu Pro brand is seeded. |
| 2026-11-09 | Ollama from the extension origin | **Bug found and fixed:** Ollama returned 403 to POSTs from `chrome-extension://`, and the provider test wrongly showed OK. It is now fixed with a DNR rule that removes the Origin header only for this extension, and a 403 now fails the test. After the fix, Test connection shows "OK — 6 local models". |
| 2026-11-09 | Studio inside the extension (real Ollama) | 3 variations generated and shown, with per-variation character counts and validation. |
| — | **Real posting to Threads or Facebook** | **Not verified.** This needs the user's logged-in accounts. Follow the checklist in [SETUP-RPA.md](SETUP-RPA.md). |
