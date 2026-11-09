# SocialPilot AI — Design

Date: 2026-11-09
Source spec: `readme.md` (master prompt). This document records where we deviate from it and what was decided in conversation.

## 1. Intent

A Chrome extension that runs CuciQu Pro's content marketing on autopilot: AI writes posts from the brand knowledge base, and the extension publishes them to **one Threads account** and **one Facebook Page** on a schedule — including a fully automatic mode (e.g. 2 posts/day) with no human review.

Why RPA: the user does not want to set up a Meta Developer App / go through App Review. They accept that Chrome must stay open and logged in, and the account risk that comes with automated UI posting.

## 2. Decisions made by the user

- **Publishing = RPA (browser UI automation)**, not the Meta Threads/Graph API. This overrides readme §10, §11 and the "no browser scraping" rule.
- Chrome stays open with the user logged in to Threads and Facebook in that same profile.
- Exactly one Threads account and one Facebook Page. No multi-account switching.
- AI provider keys / Ollama host are entered in the extension's AI Providers settings page (nothing hardcoded).
- **Autopilot mode**: AI generates and publishes on its own at a configured cadence (example: 2 posts/day), in addition to the normal manual review → schedule flow.

## 3. Goals

1. Multi-provider AI (OpenRouter, Ollama, NVIDIA) with Smart Router, Free-Only / Offline modes, Cost Guard — as readme §5.
2. AI Content Studio, Content Research, Brand Knowledge Base (seeded with CuciQu Pro) — as readme §6–8.
3. Media Library in IndexedDB, folder import via directory picker / drag-drop — readme §9.
4. RPA publishing to Threads (threads.net) and a Facebook Page (facebook.com), text + image (+ video where the UI allows).
5. Calendar + scheduler on Chrome Alarms with persistent queue, locks, dedupe, retry, restart recovery, notifications — readme §12.
6. Autopilot: daily slots, AI picks topic/content type from brand KB + saved ideas, generates, attaches unused media, publishes.
7. Dashboard + analytics from our own records only (no fabricated engagement — N/A).
8. Full dashboard page (options/tab page) + compact popup. Light/dark. Indonesian & English.

## 4. Non-goals

- Meta API / OAuth integration (may come later; keep a `Publisher` interface so an API publisher can be added).
- Backend server / 24/7 publishing while Chrome is closed. Documented as a limitation.
- Multiple accounts, multiple users, PostgreSQL.
- Engagement metrics scraping.

## 5. Anti-goals (failure even if it "works")

- Marking a post Published without seeing it confirmed on the page.
- Double-posting (retry after an ambiguous result without checking the profile first).
- Silently using a paid model or sending content to a provider the user disabled.
- Autopilot inventing prices, features, statistics or testimonials not in the knowledge base.
- Storing passwords. The extension never logs in; it uses the existing session.

## 6. RPA publishing design

- `Publisher` interface: `publish(post) -> {status, url?, error?}`; implementations `ThreadsRpaPublisher`, `FacebookPageRpaPublisher`.
- Service worker opens (or reuses) a pinned, inactive tab to the target URL, injects a content script, drives the composer: open composer → insert text (dispatching proper input events) → attach media (build `File` from IndexedDB blob, set on file input via `DataTransfer`) → click Post.
- **Selectors live in one versioned config file per platform** (with fallbacks by aria-label/role/text in ID and EN), so a Meta UI change is a one-file fix.
- **Confirmation**: after posting, verify the post appears (composer closed + new post found on profile/page feed containing the caption fingerprint). Only then → Published, store post URL if found.
- **Ambiguous outcome** (timeout after click): status `Verifying`; next attempt first searches the feed for the fingerprint before reposting.
- Pre-flight checks: logged in? correct account/page? If not → Failed with clear reason + notification.
- Human-like pacing (small randomized delays); minimum gap between posts per platform (configurable, default 60 min).
- "Test publisher" button in Social Accounts: dry run that opens the composer, fills text, and stops before Post.

## 7. Autopilot

- Settings: on/off per platform, posts per day, time windows (Asia/Jakarta), content-type rotation, language, provider mode, whether to attach media.
- Daily at 00:05 local (and on startup) the planner creates that day's slots as queue items `AutoPending`. At slot time: generate (1 variation, using brand KB + prohibited claims) → validate (length limits, prohibited-claims check, non-empty) → publish.
- Generation failure → skip slot, log, notify. Never fall back to paid models without permission.
- Generated autopilot posts appear in history with an "Auto" badge; user can pause autopilot from popup in one click.

### Builder's calls (marked, user may override)

- **Model for autopilot**: a dedicated "Autopilot model" setting. Ollama and models marked free are allowed. A paid model needs an explicit "allow paid for autopilot" toggle plus a daily Rp/USD cap. NVIDIA credit-based access counts as paid-with-credits and is shown as such.
- **Media**: images only in v1 autopilot. Pick an unused image whose tags match the content type or topic. If none is left, use the least-recently-used one. If the library is empty, post text only. Video stays manual-publish only and is experimental.
- **Per-platform content**: each slot generates separate text adapted to each platform (Threads ≤500 chars). The queue has one item per platform, and Facebook posts 30 min after Threads by default.
- **Missed slots**: if a slot is more than 2 h late, skip it. Otherwise, after a restart, post at most the latest missed slot per platform, never a burst.
- **Claim check (always on)**: generated text containing numbers, prices, percentages or currency that don't appear in the brand KB → regenerate once, then skip the slot.
- **Facebook Page access**: user enters the Page URL in Social Accounts. Publisher opens that Page URL, switches to / verifies the "posting as <Page name>" identity, and fails safely (never posts) if it cannot confirm the Page identity. Business Suite is not used in v1.
- **Review gate**: autopilot is fully automatic by default (user said yes). Optional setting "review window N min — post unless rejected" (off by default) with a notification carrying Approve/Reject.
- Meta API work from the readme is dropped entirely; only the `Publisher` interface remains for later.

## 8. Architecture

Per readme §4 layout, with `services/social/` replaced by `services/publishing/rpa/{threads,facebook}/` and `content-scripts/`. Stack per readme §3 (React, TS strict, Vite + CRXJS or equivalent MV3 build, Tailwind, shadcn/ui, Lucide, IndexedDB via Dexie, chrome.storage for settings/secrets).

Manifest permissions: `storage`, `alarms`, `notifications`, `tabs`, `scripting`, `unlimitedStorage`; host permissions: threads.net, threads.com, facebook.com, openrouter.ai, integrate.api.nvidia.com, localhost:11434 (configurable via optional host permissions).

## 9. Data

IndexedDB stores (readme §17 minus Users/SocialAccounts-OAuth): Brands, BrandKnowledge, AIProviders, AIModels, Accounts (name + platform + profile URL only), Media, ContentIdeas, Drafts, Posts (status machine: Draft → Scheduled → Processing → Verifying → Published | Failed | Cancelled), Queue, AIUsage, ActivityLogs, Settings. Export/import JSON.

API keys in `chrome.storage.local` (documented: not encrypted against local access).

## 10. Testing

- Unit: AI router (fallback, Free-Only, Offline, capability routing), Cost Guard, scheduler (dedupe, locks, retry, timezone), autopilot planner, validators — Vitest.
- Provider adapters: tested against real endpoints when keys/Ollama are available; otherwise reported as not verified.
- RPA: content-script logic unit-tested against saved DOM fixtures; real posting verified manually by the user (documented checklist). Fixtures are not claimed as proof of real publishing.
- Build, tsc, lint must pass; load-unpacked check.

## 11. Known limitations (to document)

- Chrome must be open, online, logged in; laptop sleep = missed slots (caught up or skipped per setting, default skip if >2h late).
- Meta UI changes will break RPA until selectors are updated.
- Automated posting may violate Meta terms; account may be rate-limited or restricted.
- Local folder access only via user-granted directory picker.

## 12. Left to the builder

Exact UI layouts, component breakdown, library versions, selector strategies, prompt templates, model lists.
