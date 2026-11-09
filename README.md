# SocialPilot AI

A Chrome extension (Manifest V3) that writes CuciQu Pro marketing posts with AI and publishes them to **one Threads account** and **one Facebook Page**. You can publish by hand, on a schedule, or with a fully automatic **Autopilot** (for example, 2 posts a day).

- **AI:** Ollama (local, free), NVIDIA API Catalog (credits) and OpenRouter (free and paid models). A Smart Router handles Auto, Manual, Free-Only and Offline modes. The Cost Guard tracks spending with daily caps.
- **Publishing:** posts go out through browser automation (RPA) in your own logged-in Chrome profile. There is no Meta API and no password storage.
- **Safety:** a post is marked Published only after it is seen on the feed. A retry never reposts without checking the feed first. Numbers and prices that are not in the knowledge base are rejected.

## Quick start

```bash
npm install
npm run build          # produces dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `dist/`.
2. Click the extension icon, then **Dashboard**. Set up three things:
   1. **AI Providers:** pick an Ollama model, or paste an OpenRouter or NVIDIA key, then click **Test connection**. See [docs/SETUP-AI.md](docs/SETUP-AI.md).
   2. **Social Accounts:** enter your Threads profile URL and your Facebook Page URL and name. Then run **Check login** and **Run dry run**. See [docs/SETUP-RPA.md](docs/SETUP-RPA.md).
   3. **Media Library:** click **Import folder** and choose `C:\locale\intelij\londy-artifacts-marketing\app-marketing`. Dependency and hidden folders such as `node_modules` and `.git` are skipped.
3. Write posts in **AI Content Studio**, or turn on **Settings → Autopilot**.

Chrome must stay open and logged in for scheduled posts to go out. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev build with hot reload (load `dist/` unpacked) |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit and fixture tests |
| `npx tsx scripts/check-providers.ts` | Live provider check (keys read from env: `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `OLLAMA_HOST`) |

## Project layout

```
src/
  background/        service worker: alarms, queue tick, messages, Ollama origin rule
  content/rpa.ts     content script injected into the automation window
  services/
    ai/              providers (Ollama, NVIDIA, OpenRouter), AIRouter, ModelRegistry, CostGuard
    content/         brand context, prompts, generation, parsing, validation (claim check)
    media/           folder import, autopilot media picking
    publishing/      queue, retry, posts, fingerprint, rpa/{dom, engine, selectors, tabDriver, RpaPublisher}
    autopilot/       planner (daily slots), runner (generate → validate → schedule)
    analytics/       stats from our own records
    storage/         Dexie DB, settings (chrome.storage), export/import
  pages/             dashboard pages
  popup/             compact popup
tests/               Vitest (unit, DOM fixtures, UI)
docs/                setup, schema, testing, limitations, original prompt, design spec, plan
```

## Docs

- [Setting up AI providers](docs/SETUP-AI.md)
- [Setting up RPA publishing](docs/SETUP-RPA.md)
- [Data schema](docs/SCHEMA.md)
- [Testing record](docs/TESTING.md)
- [Limitations](docs/LIMITATIONS.md)
- [Design spec](docs/superpowers/specs/2026-11-09-socialpilot-ai-design.md) · [Original prompt](docs/original-prompt.md)
