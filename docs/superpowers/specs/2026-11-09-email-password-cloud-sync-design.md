# Email/Password Cloud Sync with Backblaze B2 — Design

## Intent

SocialPilot AI already has two-way synchronization through Firebase Authentication, Firestore, and Google Drive, but authentication currently uses Google OAuth. Replace the user-facing authentication with Firebase email/password, keep structured application data in Firestore, and move cloud media to a private Backblaze B2 bucket through its S3-compatible API.

The target experience is one SocialPilot login. Setup and operational data synchronize automatically. Images and videos are available on every authorized device without requiring Google Drive authorization or Firebase Storage.

## Selected Architecture

```text
Chrome extension
  ├─ Firebase Email/Password ──> Firebase Authentication
  ├─ Firebase ID token ────────> Firestore (setup and application data)
  └─ Firebase ID token ────────> Media signer API
                                  └─ short-lived presigned URL ──> private Backblaze B2 bucket
```

- **Identity:** Firebase Authentication Email/Password; the email is the username.
- **Structured data:** Cloud Firestore under a namespace owned by the Firebase UID.
- **Media blobs:** private Backblaze B2 bucket using its S3-compatible API.
- **Media authorization:** a trusted signer API verifies the Firebase ID token and returns narrowly scoped, short-lived presigned URLs.
- **Local cache:** IndexedDB keeps downloaded/imported blobs locally for performance and offline use.
- **Publishing:** the existing Firestore publisher lease ensures only one browser publishes at a time.

## Goals

- Use email/password for the SocialPilot account.
- Synchronize brand knowledge, social-account metadata, groups, topics, ideas, posts, schedules, settings, and media metadata through Firestore.
- Upload, download, and delete media in a private Backblaze B2 bucket.
- Make cloud media available on every device signed into the same SocialPilot account.
- Keep Facebook and Threads browser cookies device-local and never collect their passwords.
- Keep AI provider keys end-to-end encrypted with the existing passphrase mechanism.
- Preserve pull-before-first-push, conditional writes, tombstones, clock-skew protection, monotonic published status, and the single-publisher lease.
- Keep local-only mode available when the user does not sign in.
- Avoid Firebase Storage and a second Google OAuth login.

## Non-goals

- Public self-service registration in the first release. An administrator provisions accounts in Firebase Authentication.
- Social login providers or Google Drive OAuth.
- A public media bucket or permanent media download URLs.
- Roles, teams, account sharing, or a web administration portal.
- Server-side publishing while Chrome is closed.
- Storing Facebook or Threads credentials.
- Replacing the existing Firestore record conflict algorithm.

## Anti-goals

- Never embed a Backblaze key, Firebase administrative credential, or signing secret in the extension bundle.
- Never put passwords, refresh tokens, plaintext AI keys, or presigned URLs in Firestore or logs.
- Never trust a UID, object path, content type, or file size supplied by the extension without server-side validation.
- Never use a public B2 bucket as a shortcut for authenticated delivery.
- Never upload local data into a different account without explicit account-switch confirmation.
- Never publish a post when its required media cannot be loaded.

## Current State

- `src/services/cloud/auth.ts` combines Google OAuth, Firebase sign-in, and a Google Drive access token.
- `src/services/cloud/firestore.ts` stores per-user records below `users/{uid}` using Firebase ID tokens and Firestore REST.
- `src/services/cloud/drive.ts` uploads media to Google Drive and caches downloaded blobs in IndexedDB.
- `src/services/cloud/sync.ts` performs dirty tracking, tombstones, conflict handling, encrypted settings sync, and media coordination.
- `src/services/cloud/leader.ts` permits only one active publishing browser.
- `src/components/LoginGate.tsx` and `src/pages/Cloud.tsx` currently expose Google sign-in and Drive state.

## Approaches Considered

### 1. Firebase Email/Password + Firestore + Backblaze B2 — selected

This provides one application login, private cross-device media, S3-compatible tooling, and avoids Firebase Storage's Blaze-plan requirement. It fits the Backblaze account already available to the operator.

Trade-off: a trusted signer API is mandatory. The extension cannot safely hold permanent B2 credentials.

### 2. Firebase Email/Password + Firestore + Google Drive

This avoids a signer API but requires a second Google OAuth connection and separate token lifecycle. It also couples media availability to the connected Google account.

### 3. Firebase Email/Password + Firestore + local-only media

This has the smallest cloud footprint but breaks seamless cross-device publishing. Posts may contain media references unavailable on the active publishing device.

### 4. Firebase Email/Password + Firebase Storage

This gives one Firebase security model, but Cloud Storage for Firebase requires a Blaze billing account even when usage remains within its no-cost quota.

## Authentication Design

### Account provisioning

- Enable Email/Password in Firebase Authentication.
- For the first release, an administrator creates users in the Firebase console.
- Do not expose public registration in the extension.
- Configure Firebase password policy and email-enumeration protection.
- Provide login, logout, and password-reset email actions.

### Session lifecycle

- Login calls Firebase Authentication REST `accounts:signInWithPassword` with `returnSecureToken: true`.
- Persist only the normalized email, UID, Firebase ID token, Firebase refresh token, and ID-token expiry in `chrome.storage.local`.
- Never persist or log the user's password.
- Refresh the ID token through the Secure Token API five minutes before expiry.
- Retry an authenticated request once after token refresh; an invalid refresh token signs the user out of cloud sync without deleting local data.
- Password reset uses `accounts:sendOobCode` with `PASSWORD_RESET` and always displays a neutral response.
- Map Firebase errors to short user-safe messages and never show raw credential-bearing responses.

### Account switching

The existing `syncUid` marker remains authoritative. If a new login UID differs from the UID that owns the synchronized local copy, require explicit confirmation before clearing synchronized local tables. Device-local logs, AI usage, queue internals, model cache, and browser sessions remain outside that wipe.

Logging out keeps the local copy usable. Edits made while logged out remain dirty and synchronize only after the same account signs in again. Signing into another account always invokes the account-switch protection.

## Firestore Data Design

Keep the existing layout:

- `users/{uid}/records/{table}__{id}` for synchronized records and tombstones.
- `users/{uid}/meta/{name}` for publisher lease, handover, and coordination state.

Firestore rules must allow access only when `request.auth != null && request.auth.uid == uid`. The extension retains compare-and-set writes, server-time pull cursors, two-minute cursor overlap, tombstones, first-sync pull-before-push, and protection against reverting a published post.

The synchronized tables remain `brands`, `knowledge`, `accounts`, `media`, `ideas`, `posts`, `groups`, `topics`, and sanitized `settings`. Queue internals, activity logs, AI usage, model cache, and local browser state remain device-local.

## Backblaze B2 Media Design

### Bucket and object layout

- Use a dedicated **private** B2 bucket.
- Create a standard application key restricted to that bucket; never use the master key.
- Give the signer only the capabilities it needs: list/read/write/delete files in the selected bucket.
- Use this canonical object key:

  `users/{firebaseUid}/media/{mediaId}/{sanitizedFileName}`

- The signer obtains `{firebaseUid}` exclusively from the verified Firebase token. It never accepts a caller-provided UID for authorization.
- Sanitize file names, but use `mediaId` as the stable identity so duplicate names cannot collide.

### Metadata

`MediaItem` gains the following cloud fields:

- `objectKey?: string`
- `etag?: string`
- `sha256?: string`
- `cloudStatus?: 'pending' | 'ready' | 'failed'`

Firestore stores metadata only: object key, original name, MIME type, byte size, hash, dimensions, tags, and usage data. It never stores the blob or a presigned URL. Existing `driveFileId` is temporary legacy metadata and is not written for new files.

### Upload flow

1. The extension validates the file locally and calculates SHA-256.
2. It calls the signer with Firebase bearer token, `mediaId`, sanitized file name, MIME type, size, and checksum.
3. The signer verifies the Firebase ID token and derives the UID.
4. The signer validates media ID format, allowlisted MIME type, maximum size, object prefix, and requested operation.
5. It returns a presigned S3 `PUT` URL valid for at most five minutes plus the exact required headers.
6. The extension uploads directly to B2, then calls a completion endpoint.
7. The completion endpoint performs `HEAD`, verifies size/content type/checksum where supported, and returns canonical object metadata.
8. Only then does the extension mark `cloudStatus: 'ready'` and sync the media record.

Backblaze's S3-compatible API supports presigned `PUT` URLs; browser-based presigned `POST` uploads are not used.

### Download flow

1. Resolve the `MediaItem` from Firestore/IndexedDB.
2. If a local blob exists and its hash matches, use it.
3. Otherwise request a short-lived presigned `GET` URL from the signer.
4. Download and verify expected byte size and SHA-256.
5. Cache the blob in IndexedDB through a quiet transaction so download caching does not trigger a re-upload.

Download URLs expire within five minutes and are never persisted.

### Delete flow

- A local delete creates the existing Firestore tombstone and a pending object-deletion marker.
- The extension calls an authenticated signer delete endpoint; the signer validates the UID prefix and deletes the object using server-side credentials.
- A missing object is treated as an idempotent success.
- Clear the pending deletion marker only after a successful or already-missing response.
- B2 bucket lifecycle/versioning settings remove old versions after a short recovery window chosen by the operator; lifecycle cleanup is documented and not silently assumed.

## Signer API Security Contract

The signer API is a required trusted component. It may run on an existing backend, VPS, or a suitable serverless platform, but its provider is an implementation/deployment decision.

### Required endpoints

- `POST /v1/media/upload-url`
- `POST /v1/media/upload-complete`
- `POST /v1/media/download-url`
- `DELETE /v1/media/object`
- `GET /v1/health`

### Required controls

- Verify Firebase ID-token signature, issuer, audience/project ID, expiry, and subject on every media request.
- Derive the UID from the verified token and enforce the `users/{uid}/media/` prefix.
- Allowlist operations; never expose arbitrary bucket, key, endpoint, expiry, or HTTP method signing.
- Allowlist MIME types. Initial types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, and `video/webm`.
- Initial maximum object size: 100 MiB. Keep this value in one shared configuration contract and enforce it both client-side and server-side.
- Limit presigned URL lifetime to five minutes.
- Rate-limit by UID and IP, with conservative burst allowances for media imports.
- Return generic errors externally; log request IDs, UID, operation, object key, duration, and result, but never tokens, B2 keys, or signed query strings.
- Accept requests only over HTTPS.
- Configure CORS for the exact deployed Chrome extension origin(s), required methods, and required headers. Do not use wildcard origins with credentials.
- Store the B2 key only in the backend secret store/environment and support rotation without rebuilding the extension.
- Use a least-privilege, bucket-restricted standard application key and a private bucket.
- Add replay resistance through short expiry, exact method/path signing, content length/type constraints, and server-side completion verification.

## Sync and Publishing Behavior

- The existing media dirty markers drive bounded uploads; retain the limit of five uploads per sync round so publishing is not starved.
- A media record is pushed as usable only after B2 completion verification succeeds.
- Failed uploads retain their dirty marker and retry with exponential backoff and jitter.
- A post requiring media must not publish until every referenced `MediaItem` is locally cached or downloadable and hash-verified.
- B2 or signer failure pauses only media-dependent publishing. Text-only posts and local editing continue.
- Publisher lease behavior remains unchanged: signed-out local mode publishes locally, while signed-in mode requires a valid Firestore lease.

## Configuration

### Extension build/runtime configuration

- Firebase Web API key
- Firebase project ID
- Media signer base URL
- Maximum media size and supported MIME contract version

### Signer secrets/configuration

- Firebase project ID/audience
- B2 S3 endpoint and region
- B2 bucket name
- Scoped B2 application key ID and application key
- Allowed Chrome extension origins
- Presigned URL TTL and rate limits

No B2 credential or Firebase admin credential is included in `.env` values exposed through Vite's `VITE_*` variables.

## Migration

Migration depends on whether the current Google/Drive cloud feature contains production data.

### No existing production cloud data

Replace Google OAuth and Drive directly, remove OAuth client configuration, remove Google/Drive host permissions, and provision email/password accounts plus the B2 signer.

### Existing production cloud data

Use a transition release:

1. Keep legacy Google sign-in and Drive access under a migration-only screen.
2. Add email/password to the same Firebase UID so the existing Firestore namespace is preserved.
3. Download each Drive-backed object, verify it, upload it to B2 in bounded resumable batches, and store `objectKey`, hash, and readiness metadata.
4. Keep `driveFileId` as fallback until every referenced object is verified in B2.
5. Show migration progress and failures; never declare completion while a referenced object remains unverified.
6. After operator confirmation, remove Google OAuth/Drive code and permissions in a later cleanup release. Do not delete the Drive folder automatically.

If the migration email is already owned by another Firebase UID, stop and require administrator resolution; never merge or move data automatically.

## User Experience

### Login gate

- Email input with `autocomplete="username"`.
- Password input with `autocomplete="current-password"` and show/hide control.
- Primary “Login” action and “Forgot password?” action.
- “Continue without an account” remains available and clearly explains that local changes are not synchronized.
- The popup sends users to the dashboard for login.

### Cloud & Sync page

- Show signed-in email, last successful sync, sent/received counts, media queue status, and actionable errors.
- Provide “Sync now”, “Logout”, passphrase management, and publishing-device controls.
- Show B2 media status without exposing bucket credentials or object URLs.
- Configuration UI contains Firebase Web API key, project ID, and signer base URL. B2 credentials are configured only on the signer service.
- Show migration controls only when legacy Google/Drive state is detected.

## Failure Behavior

- Wrong credentials do not modify local data or ownership markers.
- An expired ID token is refreshed once; invalid refresh credentials sign the user out of cloud sync.
- Offline operation keeps local editing available and retries synchronization later.
- Signer, B2, checksum, or completion-verification failures keep media dirty and unavailable for publishing.
- Firestore and media errors are reported independently so a failed media upload never looks like a fully successful sync.
- First login pulls cloud state before uploading missing local records.
- A stale device cannot overwrite newer cloud edits, and published posts cannot revert to unpublished states.
- Deletion and completion endpoints are idempotent so retries are safe.

## Testing and Acceptance

### Authentication

- Successful login, invalid password, disabled/missing account, neutral password reset, token refresh, invalid refresh token, logout, and redacted errors.
- Account-switch cancellation and confirmed local synchronized-data wipe.

### Signer API

- Valid Firebase token produces a URL limited to the correct UID prefix.
- Missing, expired, wrong-audience, or forged tokens are rejected.
- Cross-user object keys, arbitrary buckets, path traversal, unsupported operations, oversized files, and disallowed MIME types are rejected.
- Presigned URL method, headers, and expiry are exact.
- Logs never contain bearer tokens, B2 secrets, or signed URLs.
- Rate limits return a retryable response.

### Media client

- Upload, completion verification, authenticated download, hash verification, local caching, delete, already-missing delete, retry, and bounded batches.
- A replaced blob receives a new upload; a cache-only write does not.
- Media-dependent publishing pauses safely when the media is missing or corrupt.

### Existing sync guarantees

- Retain conflict, tombstone, cursor overlap, clock skew, first-sync, encrypted settings, published-status, and publisher-lease tests.
- Add integration tests proving Firestore cross-user denial and signer/B2 cross-user denial.
- If migration is required, prove UID preservation, mixed Drive/B2 reads, resumable batches, and verified completion.

### Release verification

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- Manual Chrome MV3 test: login, two-device sync, import/upload, cache miss/download, schedule/publish, account switch, offline recovery, logout, and key rotation.

## Documentation Changes

- Update `README.md` with optional email/password cloud sync and B2 media behavior.
- Replace `docs/SETUP-CLOUD.md` with Firebase Email/Password, Firestore rules, signer deployment, B2 bucket/key, CORS, and key-rotation instructions.
- Update `docs/SCHEMA.md` with cloud media fields and synchronized/device-local boundaries.
- Update `docs/LIMITATIONS.md` with signer availability, B2 quota/cost, and local-only behavior.
- Add a migration runbook if existing Google Drive cloud data must be retained.
- Add an incident runbook for B2 key revocation and rotation.

## Cost Model

- Firebase Email/Password and Firestore can remain within their no-cost quotas for a small single-brand deployment.
- Backblaze B2 currently lists the first 10 GB of storage as free; usage and egress beyond included allowances follow Backblaze pricing.
- The signer API may add hosting cost depending on its deployment target.
- Pricing and quotas are operational inputs, not permanent guarantees; confirm them before deployment and configure usage alerts where the provider supports them.

## Best-Practice Decisions

- Keep the bucket private and issue short-lived presigned URLs.
- Keep permanent storage credentials only in a trusted signer.
- Use a scoped standard B2 key, never a master key.
- Bind every object to the verified Firebase UID namespace.
- Verify upload completion and content integrity before syncing readiness.
- Preserve local cache for resilience, but treat B2 as the cloud media source of truth.
- Separate structured-data sync errors from media-transfer errors.
- Rotate B2 keys without requiring an extension rebuild.
- Prefer small, auditable REST modules over adding large SDKs to the MV3 extension; the signer may use a maintained S3 SDK.

## References

- [Backblaze B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
- [Backblaze application keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Cloud Firestore pricing and free quota](https://firebase.google.com/docs/firestore/pricing)
