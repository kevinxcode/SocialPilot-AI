# Data schema

Records live in IndexedDB, in the database `socialpilot`, managed with Dexie. Settings and API keys live in `chrome.storage.local` under the key `settings`. The types are defined in `src/types/models.ts`.

| Table | Key / indexes | Contents |
|---|---|---|
| brands | id, name | Brand profile: website, affiliate, description, products, features, pricing, audience, voice, strategy, CTA, prohibited claims |
| knowledge | id, brandId | Extra knowledge entries (title, content) |
| providers | id | Provider health: last test, latency, last success, last error |
| models | key (`provider:model`), providerId | Cached model list: isFree, vision, context, pricing per million tokens |
| accounts | id, platform | One Threads profile and one Facebook Page: URL, name, last check |
| media | id, name, createdAt, lastUsedAt, *tags, category | Image or video blob, thumbnail, size, usedCount |
| ideas | id, brandId, createdAt | Saved research ideas |
| posts | id, status, scheduledAt, platform, fingerprint, createdAt, publishedAt | Post text, media ids, status, URL, attempts, error, source (manual or autopilot), provider and model |
| queue | id, runAt, postId, slotKey, platform, kind | `post` items (publish a post) and `slot` items (an autopilot generation slot); `lockedUntil` |
| aiUsage | id, at, providerId, purpose | Tokens, latency, ok, costUsd (null means the price is unknown) |
| logs | id, at, level | Activity log |

## Post status machine

```
draft → scheduled → processing → published
                         ↓   ↘
                     verifying → published   (found on the feed)
                         ↓
                       failed               (retries exhausted / not confirmed)
scheduled → cancelled
```

- `processing`: the automation is running, and the queue item is locked for 5 minutes.
- `verifying`: the result was unclear. The feed is always checked before any repost.
- After a browser restart, `processing` becomes `verifying`.

## Export and import

**Settings → Backup** exports every table except media blobs. Settings and API keys are never exported. An import is checked with zod first and then written in a single transaction, so an invalid file writes nothing.
