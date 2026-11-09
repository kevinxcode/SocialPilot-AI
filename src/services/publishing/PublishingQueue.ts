import { fromZonedTime } from 'date-fns-tz';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { markUsed } from '@/services/media/pick';
import { uid } from '@/lib/utils';
import type { Platform, Post, QueueItem } from '@/types/models';
import type { Publisher, PublishResult } from './Publisher';
import { MAX_ATTEMPTS, nextRetryAt } from './RetryManager';
import { platformLabel } from '@/lib/platform';

export const LOCK_MS = 5 * 60_000;
/** One RPA run (open, preflight, compose, confirm) can take several minutes. */
export const PUBLISH_LOCK_MS = 15 * 60_000;
export const MISSED_TOLERANCE_MS = 5 * 60_000;
export const SKIP_LATE_MS = 2 * 60 * 60_000;
const DEDUPE_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface QueueDeps {
  publishers: Record<Platform, Publisher>;
  notify: (title: string, message: string) => void;
  loadMedia: (ids: string[]) => Promise<Blob[]>;
  /** autopilot slot runner (Task 13); slot items are ignored when absent */
  runSlot?: (item: QueueItem, now: number) => Promise<void>;
  /** Threads: choose a topic for a post that has none (AI); undefined = no topic */
  pickTopic?: (post: Post) => Promise<string | undefined>;
}

export function zonedToUtc(local: string, timezone: string): Date {
  return fromZonedTime(local, timezone);
}

const label = (p: Platform) => platformLabel(p);

export async function schedulePost(postId: string, at: Date, opts: { immediate?: boolean } = {}): Promise<void> {
  await db.transaction('rw', db.posts, db.queue, async () => {
    const post = await db.posts.get(postId);
    if (!post) throw new Error('Post not found');
    if (post.status === 'published') throw new Error('Post is already published');
    await db.queue.where('postId').equals(postId).delete();
    await db.posts.update(postId, { status: 'scheduled', scheduledAt: at.getTime(), attempts: 0, error: undefined, nextRetryAt: undefined, updatedAt: Date.now() });
    await db.queue.add({ id: uid(), kind: 'post', platform: post.platform, postId, runAt: at.getTime(), ...(opts.immediate ? { immediate: true } : {}) });
  });
}

export async function cancel(postId: string): Promise<void> {
  await db.transaction('rw', db.posts, db.queue, async () => {
    const post = await db.posts.get(postId);
    if (!post) return;
    if (post.status === 'processing' || post.status === 'verifying') throw new Error('Post is being published right now and cannot be cancelled');
    await db.queue.where('postId').equals(postId).delete();
    if (post.status !== 'published') await db.posts.update(postId, { status: 'cancelled', updatedAt: Date.now() });
  });
}

/** Atomically claims due, unlocked items. Concurrent callers never get the same item. */
async function claimDue(now: number): Promise<QueueItem[]> {
  return db.transaction('rw', db.queue, async () => {
    const due = await db.queue.where('runAt').belowOrEqual(now).toArray();
    const free = due.filter((q) => !q.lockedUntil || q.lockedUntil <= now).sort((a, b) => a.runAt - b.runAt);
    for (const q of free) await db.queue.update(q.id, { lockedUntil: now + LOCK_MS });
    return free;
  });
}

async function finish(itemId: string) {
  await db.queue.delete(itemId);
}
async function release(itemId: string, runAt?: number) {
  await db.queue.update(itemId, { lockedUntil: undefined, ...(runAt ? { runAt } : {}) });
  // Keep the post's shown time in step with when it will really be tried.
  if (runAt) {
    const q = await db.queue.get(itemId);
    if (q?.postId) await db.posts.update(q.postId, { scheduledAt: runAt, updatedAt: Date.now() });
  }
}
async function setPost(id: string, patch: Partial<Post>) {
  await db.posts.update(id, { ...patch, updatedAt: Date.now() });
}

/** Group failures that will not fix themselves on retry. */
export const PERMANENT_GROUP_FAILURE = /paused|dijeda|not a member|join the group|not found or disabled|posting is turned off/i;

/**
 * A group that can't be posted to is switched off, and its waiting posts move to another enabled group
 * (or are cancelled when there is none), so the queue never retries a dead group.
 */
export async function retireGroup(groupId: string, reason: string, now = Date.now()): Promise<{ moved: number; cancelled: number }> {
  await db.groups.update(groupId, { enabled: false, disabledReason: reason, lastCheckOk: false, lastCheckMessage: reason });
  const others = (await db.groups.toArray()).filter((g) => g.enabled && g.id !== groupId);
  const waiting = (await db.posts.where('groupId').equals(groupId).toArray()).filter((p) => p.status === 'scheduled' || p.status === 'failed');
  let moved = 0;
  let cancelled = 0;
  for (const [i, p] of waiting.entries()) {
    if (others.length) {
      await db.posts.update(p.id, { groupId: others[i % others.length].id, status: p.status === 'failed' ? 'scheduled' : p.status, error: undefined, updatedAt: now });
      if (p.status === 'failed') await schedulePost(p.id, new Date(now));
      moved++;
    } else {
      await db.posts.update(p.id, { status: 'cancelled', error: `Group switched off: ${reason}`, updatedAt: now });
      await db.queue.where('postId').equals(p.id).delete();
      cancelled++;
    }
  }
  await log('warn', 'groups', `Group switched off (${reason}); ${moved} posts moved to other groups, ${cancelled} cancelled`);
  return { moved, cancelled };
}

/**
 * A group post that failed every retry with a clear (non-ambiguous) error gets ONE more chance in another enabled
 * group that has not had a post in the last 24 h. Ambiguous posts never move: the text might already be live.
 */
async function tryAnotherGroup(item: QueueItem, post: Post, reason: string): Promise<boolean> {
  if (post.platform !== 'fbgroup' || !post.groupId || post.status === 'verifying' || /could not confirm/i.test(reason)) return false;
  const tried = [...(post.groupsTried ?? []), post.groupId];
  if (tried.length > 1) return false;
  const since = Date.now() - 24 * 3600_000;
  const recent = new Set(
    (await db.posts.where('platform').equals('fbgroup').toArray())
      .filter((p) => p.id !== post.id && ((p.status === 'published' && (p.publishedAt ?? 0) > since) || p.status === 'scheduled'))
      .map((p) => p.groupId),
  );
  const next = (await db.groups.toArray()).find((g) => g.enabled && !tried.includes(g.id) && !recent.has(g.id));
  if (!next) return false;
  await finish(item.id);
  await schedulePost(post.id, new Date());
  await db.posts.update(post.id, { groupId: next.id, groupsTried: tried, error: `Moved from another group after: ${reason}`.slice(0, 300) });
  await log('warn', 'groups', `Group post failed ${MAX_ATTEMPTS}× (${reason}) — moved to “${next.name}”`);
  return true;
}

async function fail(item: QueueItem, post: Post, reason: string, deps: QueueDeps) {
  if (post.platform === 'fbgroup' && post.groupId && PERMANENT_GROUP_FAILURE.test(reason)) {
    await finish(item.id);
    await setPost(post.id, { status: 'failed', error: reason }); // so retireGroup moves this post too
    await retireGroup(post.groupId, reason);
    deps.notify('Facebook Group switched off', reason);
    return;
  }
  if (await tryAnotherGroup(item, post, reason)) return;
  await setPost(post.id, { status: 'failed', error: reason });
  await finish(item.id);
  await log('error', 'publish', `${label(post.platform)}: ${reason}`);
  deps.notify(`${label(post.platform)} post failed`, reason);
}

export async function processDue(now: number, deps: QueueDeps): Promise<void> {
  const settings = await getSettings();
  const claimed = await claimDue(now);
  if (!claimed.length) return;

  // Missed-slot rule: among fresh (never attempted) items that are late, keep only the latest per platform.
  const postsById = new Map((await db.posts.bulkGet(claimed.map((c) => c.postId ?? ''))).filter(Boolean).map((p) => [p!.id, p!]));
  const isFreshLate = (q: QueueItem) => {
    if (now - q.runAt <= MISSED_TOLERANCE_MS) return false;
    if (q.kind === 'slot') return true;
    const p = postsById.get(q.postId ?? '');
    return !!p && p.status === 'scheduled' && p.attempts === 0;
  };
  const latestLate = new Map<string, QueueItem>();
  for (const q of claimed.filter(isFreshLate)) {
    const key = `${q.platform}|${q.kind}`;
    const cur = latestLate.get(key);
    if (!cur || q.runAt > cur.runAt) latestLate.set(key, q);
  }

  for (const item of claimed) {
    try {
      if (isFreshLate(item)) {
        const tooLate = now - item.runAt > SKIP_LATE_MS;
        // "Only the latest missed slot" applies to autopilot cadence; manual posts are kept and spaced by the min gap.
        const superseded = item.kind === 'slot' && latestLate.get(`${item.platform}|${item.kind}`) !== item;
        // Late autopilot slots are dropped (a fresh one comes tomorrow); late posts you wrote are still published,
        // spaced by the minimum gap, and their time moves forward.
        if (item.kind === 'slot' && (tooLate || superseded)) {
          const reason = tooLate
            ? 'Skipped: more than 2 h late (Chrome was closed or asleep at the scheduled time)'
            : 'Skipped: missed slot superseded by a later one (only the latest missed slot is posted)';
          await finish(item.id);
          await log('warn', 'autopilot', `${label(item.platform)} slot ${item.slotKey}: ${reason}`);
          continue;
        }
      }
      if (item.kind === 'slot') {
        if (deps.runSlot) await deps.runSlot(item, now);
        else await release(item.id);
        continue;
      }
      await processPostItem(item, now, settings.minGapMinutes, settings.groupGapMinutes, deps);
    } catch (e) {
      await log('error', 'queue', `Queue item ${item.id}: ${(e as Error).message}`);
      await release(item.id, now + 2 * 60_000);
    }
  }
}

async function processPostItem(item: QueueItem, now: number, minGapMinutes: number, groupGapMinutes: number, deps: QueueDeps): Promise<void> {
  const post = await db.posts.get(item.postId ?? '');
  if (!post || post.status === 'cancelled' || post.status === 'published' || post.status === 'draft') {
    await finish(item.id);
    return;
  }
  const pub = deps.publishers[post.platform];
  if (post.replyTo && post.status === 'scheduled') {
    const current = await getSettings();
    if (!current.comments.enabled || !current.autopilot.enabled || current.autopilot.paused || !current.autopilot.platforms.threads) {
      await release(item.id, now + 5 * 60_000);
      return;
    }
  }

  // Ambiguous previous attempt (unknown result, or a run that died mid-publish): look before (re)posting.
  const ambiguous = post.status === 'verifying' || post.status === 'processing';
  if (ambiguous) {
    let f: { found: boolean; url?: string };
    try {
      f = await pub.findExisting(post);
    } catch (e) {
      if ((e as Error).name === 'TabClosedError') {
        await userCancelled(item, post, 'Cancelled: you closed the SocialPilot tab during the feed check. It may already be posted — check your profile.');
        return;
      }
      // Could not look at the feed: never treat that as "not posted". Try the check again later.
      await setPost(post.id, { status: 'verifying', error: `Feed check failed: ${(e as Error).message}` });
      await release(item.id, now + 2 * 60_000);
      return;
    }
    if (f.found) {
      await markPublished(item, post, now, f.url, deps);
      return;
    }
    // A missing visible reply is not proof it was never submitted (collapsed/moderated replies).
    if (post.replyTo) {
      await setPost(post.id, { status: 'verifying', error: 'Reply not yet visible; automatic resend disabled to prevent duplicates', nextRetryAt: now + 30 * 60_000 });
      await release(item.id, now + 30 * 60_000);
      return;
    }
    if (post.attempts >= MAX_ATTEMPTS) {
      await fail(item, post, `Could not confirm the post after ${MAX_ATTEMPTS} attempts — check the profile manually before reposting`, deps);
      return;
    }
  }

  // Minimum gap between posts on the same platform (groups: shorter gap across groups, max 1 per group per 24 h).
  const last = await db.posts.where('platform').equals(post.platform).filter((p) => p.status === 'published' && !!p.publishedAt).reverse().sortBy('publishedAt');
  if (post.platform === 'fbgroup') {
    const sameGroup = last.find((p) => p.groupId === post.groupId);
    if (sameGroup && now - sameGroup.publishedAt! < DAY_MS) {
      await release(item.id, sameGroup.publishedAt! + DAY_MS);
      await log('info', 'queue', 'Facebook Group: deferred — max 1 post per group per 24 h');
      return;
    }
  }
  const lastAt = last[0]?.publishedAt ?? 0;
  const gapMs = (post.platform === 'fbgroup' ? groupGapMinutes : minGapMinutes) * 60_000;
  if (lastAt && now - lastAt < gapMs && !item.immediate) {
    await setPost(post.id, { nextRetryAt: lastAt + gapMs, error: `Waiting: min ${gapMs / 60_000} min gap after the last ${label(post.platform)} post` });
    await release(item.id, lastAt + gapMs);
    await log('info', 'queue', `${label(post.platform)}: deferred to respect ${minGapMinutes} min gap`);
    return;
  }

  // An identical post whose outcome is still unclear may already be live: wait for it to resolve.
  const pendingTwin = await db.posts
    .where('fingerprint')
    .equals(post.fingerprint)
    .filter((p) => p.id !== post.id && p.platform === post.platform && (p.status === 'verifying' || p.status === 'processing'))
    .first();
  if (pendingTwin) {
    await release(item.id, now + 5 * 60_000);
    await log('info', 'queue', `${label(post.platform)}: identical post is still being verified — waiting`);
    return;
  }

  // Dedupe against recently published identical content.
  const dup = await db.posts
    .where('fingerprint')
    .equals(post.fingerprint)
    .filter((p) => p.id !== post.id && p.platform === post.platform && p.status === 'published' && (p.publishedAt ?? 0) > now - DEDUPE_MS)
    .first();
  if (dup) {
    await fail(item, post, `Duplicate of a post published ${new Date(dup.publishedAt!).toLocaleString()}`, deps);
    return;
  }

  if (post.platform === 'threads' && !post.replyTo && !post.topic && deps.pickTopic) {
    const topic = await deps.pickTopic(post).catch(() => undefined);
    if (topic) {
      post.topic = topic;
      await setPost(post.id, { topic });
      await log('info', 'topic', `Threads topic: ${topic}`);
    } else {
      await log('warn', 'topic', 'No topic chosen (AI unavailable and the topic list is empty)');
    }
  }

  const attempts = post.attempts + 1;
  await db.queue.update(item.id, { lockedUntil: Date.now() + PUBLISH_LOCK_MS });
  await setPost(post.id, { status: 'processing', attempts, error: undefined });
  let res: PublishResult;
  try {
    res = await pub.publish({ ...post, attempts }, await deps.loadMedia(post.mediaIds), {});
  } catch (e) {
    res = { status: 'unknown', reason: (e as Error).message };
  }

  if (res.status === 'published') {
    if (res.note) await setPost(post.id, { note: res.note });
    await markPublished(item, { ...post, attempts }, now, res.url, deps);
    return;
  }
  if (res.status === 'cancelled') {
    await userCancelled(item, post, res.reason);
    return;
  }
  if (res.status === 'dry-run') {
    await fail(item, post, 'Unexpected dry-run result', deps);
    return;
  }
  const retryAt = nextRetryAt(attempts, now);
  if (res.status === 'unknown') {
    await setPost(post.id, { status: 'verifying', error: res.reason ?? 'Outcome unclear — will check the feed before retrying', nextRetryAt: retryAt ?? now + 2 * 60_000 });
    await release(item.id, retryAt ?? now + 2 * 60_000);
    await log('warn', 'publish', `${label(post.platform)}: outcome unknown (${res.reason ?? ''}) — verifying`);
    return;
  }
  const permanent = post.platform === 'fbgroup' && PERMANENT_GROUP_FAILURE.test(res.reason ?? '');
  if (retryAt && !permanent) {
    // After an ambiguous attempt every later attempt must look at the feed first, so stay in 'verifying'.
    await setPost(post.id, { status: ambiguous ? 'verifying' : 'scheduled', error: res.reason, nextRetryAt: retryAt });
    await release(item.id, retryAt);
    await log('warn', 'publish', `${label(post.platform)}: attempt ${attempts} failed (${res.reason}); retrying at ${new Date(retryAt).toLocaleTimeString()}`);
  } else {
    await fail(item, { ...post, attempts }, res.reason, deps);
  }
}

async function userCancelled(item: QueueItem, post: Post, reason: string) {
  await setPost(post.id, { status: 'cancelled', error: reason, nextRetryAt: undefined });
  await finish(item.id);
  await log('info', 'publish', `${label(post.platform)}: ${reason}`);
}

async function markPublished(item: QueueItem, post: Post, now: number, url: string | undefined, deps: QueueDeps) {
  await setPost(post.id, { status: 'published', publishedAt: Math.max(now, Date.now()), url, error: undefined, attempts: post.attempts, nextRetryAt: undefined });
  await finish(item.id);
  for (const m of post.mediaIds) await markUsed(m);
  await log('info', 'publish', `${label(post.platform)}: published${url ? ` ${url}` : ''}`);
  deps.notify(`Published to ${label(post.platform)}`, post.text.slice(0, 90));
}

/** After a browser/service-worker restart: processing → verifying, stale locks cleared. */
export async function recoverOnStartup(now: number): Promise<void> {
  await db.transaction('rw', db.posts, db.queue, async () => {
    const stuck = await db.posts.where('status').equals('processing').toArray();
    for (const p of stuck) {
      await db.posts.update(p.id, { status: 'verifying', error: 'Interrupted (browser restarted) — checking the feed before retrying', updatedAt: now });
      if (!(await db.queue.where('postId').equals(p.id).count())) {
        await db.queue.add({ id: uid(), kind: 'post', platform: p.platform, postId: p.id, runAt: now });
      }
    }
    await db.queue.toCollection().modify((q) => {
      delete q.lockedUntil;
    });
  });
}

/**
 * Scheduled/verifying posts whose queue item went missing (e.g. an interrupted run) would wait forever.
 * Re-queue them now; the gap and duplicate rules still apply.
 */
export async function repairOrphans(now: number): Promise<number> {
  return db.transaction('rw', db.posts, db.queue, async () => {
    // Posts that an older version skipped for being late get another chance.
    const skipped = (await db.posts.where('status').equals('failed').toArray()).filter((p) => p.source !== 'autopilot' && /^Skipped: more than 2 h late/.test(p.error ?? ''));
    for (const p of skipped) await db.posts.update(p.id, { status: 'scheduled', error: undefined, attempts: 0, scheduledAt: now, updatedAt: now });
    const live = await db.posts.where('status').anyOf('scheduled', 'verifying').toArray();
    let n = 0;
    for (const p of live) {
      if (await db.queue.where('postId').equals(p.id).count()) continue;
      await db.queue.add({ id: uid(), kind: 'post', platform: p.platform, postId: p.id, runAt: Math.max(now, p.scheduledAt ?? 0) });
      n++;
    }
    return n;
  });
}
