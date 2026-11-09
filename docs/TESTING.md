# Testing record

Honest record of what has been verified and how. "Not verified" means exactly that.

## Live AI provider checks (`npx tsx scripts/check-providers.ts`)

| Date | Provider | Result |
|------|----------|--------|
| 2026-11-09 | Ollama (localhost:11434) | OK — 6 chat models listed (embedding-only `bge-m3` filtered out), 4 with vision. Real streamed chat with `qwen3:8b` returned Indonesian text in ~0.5 s. Found and fixed: reasoning models returned empty content until `think:false` was sent. |
| 2026-11-09 | OpenRouter | **Not verified** — no API key available in the build environment. Unit-tested against recorded response shapes only. |
| 2026-11-09 | NVIDIA | **Not verified** — no API key available. Unit-tested against recorded response shapes only. |
