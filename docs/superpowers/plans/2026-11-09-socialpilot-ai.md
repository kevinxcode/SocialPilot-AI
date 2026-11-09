# SocialPilot AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MV3 Chrome extension that generates CuciQu Pro content with OpenRouter/Ollama/NVIDIA and publishes it by RPA to one Threads account and one Facebook Page, manually, on a schedule, or by autopilot.

**Architecture:** React dashboard (extension page) + popup share a Dexie (IndexedDB) data layer. A service worker owns alarms, the queue, the autopilot planner and the publishers. Publishers drive a background tab through content scripts whose selectors live in per-platform config files. AI calls go through `AIRouter`, which enforces mode, capability and cost rules.

**Tech Stack:** Vite 5, @crxjs/vite-plugin 2, React 18, TypeScript 5 (strict), Tailwind 3, shadcn/ui, lucide-react, Dexie 4, zod, date-fns-tz, Vitest + fake-indexeddb + jsdom, ESLint.

**Spec:** `docs/superpowers/specs/2026-11-09-socialpilot-ai-design.md` (source: `readme.md`)

## Global Constraints

- Manifest V3; permissions exactly: `storage`, `alarms`, `notifications`, `tabs`, `scripting`, `unlimitedStorage`; hosts: `https://*.threads.net/*`, `https://*.threads.com/*`, `https://*.facebook.com/*`, `https://openrouter.ai/*`, `https://integrate.api.nvidia.com/*`, `http://localhost:11434/*`; other Ollama hosts via `optional_host_permissions`.
- Default timezone `Asia/Jakarta`. Languages `id` and `en`.
- Router default priority: Ollama → NVIDIA → OpenRouter (configurable). Modes: `manual | auto | freeOnly | offline`.
- Never use a paid model unless `allowPaid` (manual/auto) or `autopilot.allowPaid` + daily cap. Offline = Ollama only. Never route images to a text-only model.
- Post statuses: `draft | scheduled | processing | verifying | published | failed | cancelled`. `published` only after on-page confirmation.
- Threads text ≤ 500 chars. Min gap between posts per platform default 60 min. Facebook autopilot offset +30 min after Threads.
- Missed slot > 2 h late → skip; otherwise post at most the latest missed slot per platform.
- Ollama cost shown `Rp0` with note "local hardware/electricity not included". Engagement metrics always `N/A`.
- No secrets in code, no logging of keys, request timeout default 60 s (Ollama 180 s).
- Git: repo initialised in Task 1; commit after each task.

## Review Focus

1. Caption contains emoji / newlines / Indonesian chars → typed into composer exactly (test in Task 11 fixture).
2. Browser restarts while a post is `processing` → recovered to `verifying`, feed-checked before any repost (Task 12).
3. User logged out or Facebook acting as personal profile → `failed` with reason, never posts (Task 11).
4. All providers fail or only paid available in freeOnly → clear error, no request sent to paid model (Task 5).
5. Generated text includes a price/number not in the KB → regenerate once then skip (Task 13).

---

### Task 1: Scaffold extension

**Files:** Create `package.json`, `vite.config.ts`, `manifest.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`, `.eslintrc.cjs`, `vitest.config.ts`, `src/dashboard/index.html`, `src/dashboard/main.tsx`, `src/popup/index.html`, `src/popup/main.tsx`, `src/background/service-worker.ts`, `src/components/ui/*` (shadcn: button, card, input, textarea, select, switch, badge, dialog, tabs, toast, table), `.gitignore`.

**Interfaces:** Produces npm scripts `dev`, `build`, `typecheck` (`tsc --noEmit`), `lint`, `test` (`vitest run`).

- [ ] `git init`; create the files; manifest per Global Constraints, `options_page` = dashboard, `action.default_popup` = popup, CSP `script-src 'self'; object-src 'self'`.
- [ ] `npm install`
- [ ] Add smoke test `tests/smoke.test.ts` asserting manifest permissions equal the Global Constraints list.
- [ ] Run `npm run typecheck && npm run lint && npm test && npm run build` → all pass, `dist/manifest.json` exists.
- [ ] Commit `chore: scaffold MV3 extension`.

### Task 2: Data layer

**Files:** Create `src/types/models.ts`, `src/services/storage/db.ts`, `src/services/storage/settings.ts`, `src/services/storage/exportImport.ts`; Test `tests/storage/*.test.ts`.

**Interfaces — Produces:**
- Types `Brand, BrandKnowledge, ProviderConfig, AIModel, Account{platform:'threads'|'facebook', name, profileUrl}, MediaItem{blob,tags,width,height,lastUsedAt?,usedCount}, ContentIdea, Post{id, platform, accountId, text, mediaIds, status, scheduledAt?, publishedAt?, url?, fingerprint, source:'manual'|'autopilot', attempts, error?}, QueueItem{postId, runAt, lockedUntil?}, AIUsage, ActivityLog, Settings`.
- `db: Dexie` with tables `brands, knowledge, providers, models, accounts, media, ideas, posts, queue, aiUsage, logs`; index `posts: status, scheduledAt, platform, fingerprint`.
- `getSettings(): Promise<Settings>`, `updateSettings(p: Partial<Settings>)` on chrome.storage.local (defaults incl. timezone, router, autopilot, minGapMinutes 60).
- `exportAll(): Promise<Blob>`, `importAll(file: Blob): Promise<void>` (zod-validated; media excluded from export by default).
- Seed CuciQu Pro brand from spec §8 on first run (`seedIfEmpty()`).

- [ ] Tests: seed creates one brand named "CuciQu Pro" with website `https://cuciqu.com/`; export→import round-trips posts; invalid import rejects without writing.
- [ ] Implement, run `npm test`, commit `feat: data layer`.

### Task 3: AI provider adapters

**Files:** Create `src/services/ai/types.ts`, `src/services/ai/providers/{OpenRouterProvider,OllamaProvider,NvidiaProvider}.ts`, `src/services/ai/http.ts`; Test `tests/ai/providers.test.ts`.

**Interfaces — Produces:**
```ts
interface ChatRequest { messages: {role:'system'|'user'|'assistant'; content: string; images?: string[]}[]; model: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }
interface AIProvider { id:'openrouter'|'ollama'|'nvidia'; listModels(): Promise<AIModel[]>; test(): Promise<{ok:boolean; message:string; latencyMs:number}>; chat(req: ChatRequest, onToken?: (t:string)=>void): Promise<{text:string; usage?:{in:number; out:number}}> }
AIModel { id, providerId, name, isFree: boolean, vision: boolean, contextLength?: number, pricing?: {inPerM:number; outPerM:number} }
```
- OpenRouter: `GET /api/v1/models` (free = prompt & completion price "0"; vision = `architecture.input_modalities` includes `image`), `POST /api/v1/chat/completions` SSE.
- Ollama: `GET /api/tags`, `POST /api/show` for capabilities (vision if `capabilities` includes `vision`), `POST /api/chat` NDJSON stream. Map errors: network → "Ollama not running", 403 → CORS hint `OLLAMA_ORIGINS=chrome-extension://*`, 404 model → "model not installed: ollama pull <name>".
- NVIDIA: `GET https://integrate.api.nvidia.com/v1/models`, OpenAI-compatible `/v1/chat/completions`; `isFree=false` (label "credits").
- `fetchWithTimeout(url, init, ms)`.

- [ ] Tests with stubbed `fetch`: model parsing for each provider (free/vision flags), SSE and NDJSON stream accumulation, Ollama error mapping for the three cases, timeout aborts.
- [ ] Implement; `npm test`; commit `feat: AI provider adapters`.

### Task 4: Live provider check script

**Files:** Create `scripts/check-providers.ts` (run with `npx tsx`), reading keys from env.
- [ ] Runs `test()` + `listModels()` for each provider with available config; prints ok/skip. Record real results in `docs/TESTING.md` (state "not verified" where no key). Commit.

### Task 5: Router, registry, Cost Guard

**Files:** Create `src/services/ai/{AIRouter,ModelRegistry,CostGuard}.ts`; Test `tests/ai/router.test.ts`, `tests/ai/costguard.test.ts`.

**Interfaces — Produces:**
- `ModelRegistry.refresh(providerId)`, `ModelRegistry.get(providerId, modelId): AIModel|undefined`.
- `AIRouter.generate(req: {messages, needsVision?: boolean, purpose:'interactive'|'autopilot'}, onToken?): Promise<{text, providerId, modelId}>` — throws `RouterError{code:'NO_ELIGIBLE'|'ALL_FAILED'|'COST_CAP', attempts}`.
- `CostGuard.record(u: AIUsage)`, `CostGuard.estimate(model, usage): number|null` (null when no pricing), `CostGuard.todaySpend(purpose)`, `CostGuard.summary(range)`.

- [ ] Tests: fallback to next provider on failure; freeOnly never calls paid model; offline only Ollama; vision request skips non-vision; manual mode uses only selected provider (no fallback); autopilot with paid model and `autopilot.allowPaid=false` → `NO_ELIGIBLE`; daily cap exceeded → `COST_CAP`; disabled provider never called; Ollama cost 0.
- [ ] Implement; test; commit.

### Task 6: App shell & AI Providers page

**Files:** Create `src/dashboard/App.tsx`, `src/layouts/Sidebar.tsx` (11 items from readme §15), `src/pages/AIProviders.tsx`, `src/pages/Settings.tsx`, `src/hooks/useLiveQuery.ts`, theme toggle, i18n `src/i18n/{id,en}.ts`.
- [ ] Provider cards: status, key/host input (password field), model select with Free/Vision badges, Test, enable switch, last success; mode selector + priority drag order. Settings: timezone, language, theme, min gap, export/import.
- [ ] Component tests (jsdom) for card test-button state; build; manual load-unpacked check; commit.

### Task 7: Brand Knowledge Base

**Files:** `src/pages/BrandKnowledge.tsx`, `src/services/content/brandContext.ts`; Test `tests/content/brandContext.test.ts`.
**Produces:** `buildBrandContext(brandId): Promise<string>` (system-prompt block incl. prohibited claims and "never invent prices/features/stats/testimonials"), `allowedFacts(brandId): Set<string>` (numbers/prices found in KB text).
- [ ] Tests: context includes prohibited claims; allowedFacts extracts `Rp 99.000`, `50%`, `3`.
- [ ] Page: CRUD brands, active brand switch. Commit.

### Task 8: Content Studio & Research

**Files:** `src/services/content/{prompts,generate,parse,validate}.ts`, `src/pages/ContentStudio.tsx`, `src/pages/Research.tsx`; Tests `tests/content/*.test.ts`.
**Produces:**
- `generateVariations(input: StudioInput, n=3): Promise<Variation[]>`, `Variation{title, hook, caption, body, cta, hashtags[], suggestedTime, imagePrompt, platform}` — prompts ask for JSON; `parseVariations` tolerant of fenced JSON.
- `transform(text, action:'rewrite'|'shorten'|'expand'|'hook'|'tone'|'hashtags', opts)`.
- `validatePost(text, platform, brandId): {ok, errors[]}` — empty, Threads >500, numbers not in `allowedFacts`.
- Research: ideas/pain points/weekly plan/engagement questions → save as `ContentIdea`; label "AI-generated, not real-time trends"; competitor analysis only from user-pasted text/URLs fetched by user action.
- [ ] Tests: parse fenced/unfenced JSON, 3 variations, validate rejects 501-char Threads and unknown price.
- [ ] UI: inputs per readme §6, 12 content types, actions Copy/Save Draft/Schedule/Publish Now. Commit.

### Task 9: Media Library

**Files:** `src/services/media/{importer,pick}.ts`, `src/pages/MediaLibrary.tsx`; Tests.
**Produces:** `importFiles(files: File[]|FileSystemDirectoryHandle)`, `pickMedia(topicTags: string[]): Promise<MediaItem|null>` (unused tag match → unused any → least-recently-used → null), `markUsed(id)`.
- [ ] Tests for pick order. UI: `showDirectoryPicker`, drag-drop, grid, search, tag/category filter, dims, used badge. Commit.

### Task 10: Social accounts setup

**Files:** `src/pages/SocialAccounts.tsx`.
- [ ] One Threads (profile URL) + one Facebook Page (Page URL, Page name). "Check login" and "Test publisher (dry run)" buttons → messages to service worker (Task 11). Commit.

### Task 11: RPA publishers

**Files:** `src/services/publishing/Publisher.ts`, `src/services/publishing/rpa/tabDriver.ts`, `src/services/publishing/rpa/threads/{selectors.ts,ThreadsRpaPublisher.ts,content.ts}`, `.../facebook/{selectors.ts,FacebookPageRpaPublisher.ts,content.ts}`, `src/services/publishing/rpa/dom.ts`; Tests `tests/rpa/*.test.ts` + fixtures `tests/fixtures/{threads,facebook}/*.html`.

**Produces:**
```ts
interface Publisher { platform; preflight(acc): Promise<{ok:boolean; reason?:string}>; publish(post, media: Blob[], opts:{dryRun?:boolean}): Promise<PublishResult>; findExisting(post): Promise<{found:boolean; url?:string}> }
type PublishResult = {status:'published'; url?:string} | {status:'failed'; reason:string} | {status:'unknown'}
```
- `dom.ts`: `findBySelectors(list)`, `typeText(el, text)` (execCommand insertText / InputEvent so React sees it), `attachFiles(input, files)` via DataTransfer, `waitFor(fn, ms)`.
- Selectors: ordered arrays (role/aria-label in EN and ID, text fallbacks), versioned `SELECTORS_VERSION`.
- Facebook preflight must confirm Page identity on Page URL ("posting as <Page name>"); otherwise `failed: not posting as Page`.
- Confirmation: composer closed and feed contains `fingerprint` (first 60 normalized chars). Click done but no confirmation in 90 s → `unknown`.
- [ ] Fixture tests: typeText preserves emoji/newlines; preflight fails on logged-out fixture and on personal-profile fixture; findExisting matches fingerprint.
- [ ] Manual: user runs dry run on real accounts; record in TESTING.md. Commit.

### Task 12: Queue, scheduler, calendar

**Files:** `src/services/publishing/{PublishingQueue,Scheduler,RetryManager}.ts`, `src/background/service-worker.ts`, `src/pages/{Calendar,ScheduledPosts}.tsx`; Tests.
**Produces:** `schedulePost(postId, at: Date)`, `cancel(postId)`, `processDue(now)`, `recoverOnStartup(now)`; alarm `queue-tick` every 1 min.
- Lock via `lockedUntil` (5 min); dedupe by fingerprint+platform among published in last 7 days; retry backoff 2/10/30 min max 3; `unknown` → `verifying` → `findExisting` before retry; min gap enforced; notification on publish/fail.
- [ ] Tests: no double processing under concurrent `processDue`; restart with `processing` → `verifying` and no repost if found; >2 h late → skipped; min gap defers; Asia/Jakarta conversion.
- [ ] Calendar: month/week/day/list, drag to reschedule, filters platform/status, duplicate/delete. Commit.

### Task 13: Autopilot

**Files:** `src/services/autopilot/{planner,runner}.ts`, autopilot section in Settings, pause toggle in popup; Tests.
**Produces:** `planDay(date): QueueItem[]` (slots from settings windows; Facebook +30 min), `runSlot(slot)`: generate (purpose autopilot) → `validatePost` → regenerate once → skip+log; pick media; optional review window notification Approve/Reject (default off).
- [ ] Tests: 2 posts/day → 2 Threads + 2 Facebook slots at expected Jakarta times; unknown price twice → skipped, nothing published; paused → nothing planned; missed-slot rule.
- [ ] Commit.

### Task 14: Dashboard, analytics, popup

**Files:** `src/pages/{Dashboard,Analytics,History}.tsx`, `src/popup/Popup.tsx`.
- [ ] Counts from `posts`, success rate, per-platform, provider usage and cost from CostGuard, activity log, upcoming list, quick generate; engagement = N/A. Popup: status, next post, autopilot pause, quick generate, open dashboard. Commit.

### Task 15: Docs & final verification

**Files:** `README.md` (keep original prompt as `docs/original-prompt.md`), `docs/{SETUP-AI,SETUP-RPA,SCHEMA,TESTING,LIMITATIONS}.md`.
- [ ] Run `npm run typecheck && npm run lint && npm test && npm run build`; load unpacked; record results honestly. Commit.
