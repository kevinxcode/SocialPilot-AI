# Testing record

Honest record of what has been verified and how. "Not verified" means exactly that.

## Live AI provider checks (`npx tsx scripts/check-providers.ts`)

| Date | Provider | Result |
|------|----------|--------|
| 2026-11-09 | Ollama (localhost:11434) | OK — 6 chat models listed (embedding-only `bge-m3` filtered out), 4 with vision. Real streamed chat with `qwen3:8b` returned Indonesian text in ~0.5 s. Found and fixed: reasoning models returned empty content until `think:false` was sent. |
| 2026-11-09 | OpenRouter | OK with the user's key (passed via env, not stored): 461 models listed, 16 free, 314 vision. Real streamed chat with free `stealth/crouton-alpha` returned Indonesian text. Found and fixed: HTTP-200 JSON error bodies (upstream 429 on free models) were reported as "empty response"; now surfaced as `error 429` and retryable. Free models are frequently rate-limited upstream — the router falls back. |
| 2026-11-09 | NVIDIA | **Not verified** — no API key available. Unit-tested against recorded response shapes only. |
