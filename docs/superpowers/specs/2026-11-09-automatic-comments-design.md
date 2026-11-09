# Automatic Threads comments and RPA reliability

User direction: automatic relevant comments without per-comment approval; retain Threads posts, topic research and Facebook Group publishing.

Approach: extend the existing extension and shared publishing queue. Read Threads search results through RPA, ask the configured AI for a structured relevance decision and original reply, validate the result, and persist its target before scheduling. This reuses account checks, costs, logs and restart handling. A separate browser agent would duplicate these responsibilities; replacing the extension with an API service is outside this change.

Defaults: comments follow the enabled/unpaused Threads autopilot and its time window, maximum 3 daily, at least 60 minutes apart. No approval step. Disabled master autopilot remains disabled. Target identity, original text, own-account exclusion and target deduplication are checked. Page text is untrusted data, never instructions. AI cannot supply executable code, selectors or arbitrary navigation URLs. Unclear submission results are verified without automatically sending a second comment. UI exposes comment enablement, caps and activity through the existing queue.

Reliability: use visible DOM elements, select a dialog containing the editor, propagate tab focus failures, clean navigation waiters and timeouts. Keep Group publishing enabled only for groups selected by the user. Do not assert live Meta compatibility from fixture tests; live account verification remains a separate check.

Verification: regression tests for hidden elements, wrong targets, invalid AI output, daily/gap limits, duplicate targets and ambiguous replies; full suite, TypeScript, strict lint and isolated production build.
