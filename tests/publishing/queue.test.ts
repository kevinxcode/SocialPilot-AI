import { schedulePost, cancel, processDue, recoverOnStartup, zonedToUtc, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { BACKOFF_MIN } from '@/services/publishing/RetryManager';
import { db, resetDb } from '@/services/storage/db';
import type { Publisher, PublishResult } from '@/services/publishing/Publisher';
import type { Post } from '@/types/models';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T03:00:00Z');

function fakePublisher(results: (PublishResult | 'throw')[], found: { found: boolean; url?: string }[] = [{ found: false }]): Publisher & { calls: number; finds: number } {
  const p = {
    platform: 'threads' as const,
    calls: 0,
    finds: 0,
    preflight: async () => ({ ok: true }),
    publish: vi.fn(async () => {
      p.calls++;
      await new Promise((r) => setTimeout(r, 5));
      const r = results.length > 1 ? results.shift()! : results[0];
      if (r === 'throw') throw new Error('boom');
      return r;
    }),
    findExisting: vi.fn(async () => {
      p.finds++;
      return found.length > 1 ? found.shift()! : found[0];
    }),
  };
  return p;
}

let notes: string[];
function deps(pub: Publisher, extra: Partial<QueueDeps> = {}): QueueDeps {
  return {
    publishers: { threads: pub, facebook: pub, fbgroup: pub },
    notify: (t, m) => notes.push(`${t}: ${m}`),
    loadMedia: async () => [],
    ...extra,
  };
}

async function addPost(id: string, p: Partial<Post> = {}): Promise<Post> {
  const post: Post = {
    id, platform: 'threads', accountId: 'a', text: `teks ${id}`, mediaIds: [], status: 'draft', fingerprint: `teks ${id}`,
    source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0, ...p,
  };
  await db.posts.put(post);
  return post;
}

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  notes = [];
});

test('an uncertain reply is verified but never automatically submitted a second time', async () => {
  await addPost('reply', { status: 'verifying', attempts: 1, replyTo: 'https://www.threads.com/@owner/post/abc' });
  await db.queue.add({ id: 'q', postId: 'reply', kind: 'post', platform: 'threads', runAt: T0 });
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.finds).toBe(1);
  expect(pub.calls).toBe(0);
  expect((await db.posts.get('reply'))?.status).toBe('verifying');
  expect((await db.queue.get('q'))?.runAt).toBe(T0 + 30 * MIN);
});

test('schedule then process publishes once and records url', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  expect((await db.posts.get('p1'))?.status).toBe('scheduled');
  const pub = fakePublisher([{ status: 'published', url: 'https://t/1' }]);
  await processDue(T0 + 10_000, deps(pub));
  const p = await db.posts.get('p1');
  expect(p).toMatchObject({ status: 'published', url: 'https://t/1', attempts: 1 });
  expect(await db.queue.count()).toBe(0);
  expect(notes.join()).toMatch(/Published/);
});

test('not due yet → nothing happens', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0 + 5 * MIN));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
});

test('no double processing under concurrent processDue', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await Promise.all([processDue(T0 + 1000, deps(pub)), processDue(T0 + 1000, deps(pub)), processDue(T0 + 1000, deps(pub))]);
  expect(pub.calls).toBe(1);
});

test('failed → retried 3 times with backoff 2/10/30 min, then failed', async () => {
  expect(BACKOFF_MIN).toEqual([2, 10, 30]);
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'failed', reason: 'Not logged in' }]);
  await processDue(T0, deps(pub));
  let q = await db.queue.toArray();
  expect(q[0].runAt).toBe(T0 + 2 * MIN);
  expect((await db.posts.get('p1'))?.status).toBe('scheduled');
  await processDue(T0 + 2 * MIN, deps(pub));
  q = await db.queue.toArray();
  expect(q[0].runAt).toBe(T0 + 12 * MIN);
  await processDue(T0 + 12 * MIN, deps(pub));
  q = await db.queue.toArray();
  expect(q[0].runAt).toBe(T0 + 42 * MIN);
  await processDue(T0 + 42 * MIN, deps(pub));
  expect(pub.calls).toBe(4);
  const p = await db.posts.get('p1');
  expect(p?.status).toBe('failed');
  expect(p?.error).toMatch(/Not logged in/);
  expect(await db.queue.count()).toBe(0);
});

test('unknown outcome → verifying; next run checks feed first and does not repost when found', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'unknown', reason: 'timeout' }], [{ found: true, url: 'https://t/found' }]);
  await processDue(T0, deps(pub));
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
  await processDue(T0 + 2 * MIN, deps(pub));
  expect(pub.calls).toBe(1);
  expect(pub.finds).toBe(1);
  expect(await db.posts.get('p1')).toMatchObject({ status: 'published', url: 'https://t/found' });
});

test('restart with a processing post → verifying, feed-checked, no repost if found', async () => {
  await addPost('p1', { status: 'processing', attempts: 1, scheduledAt: T0 });
  await db.queue.put({ id: 'q1', kind: 'post', platform: 'threads', postId: 'p1', runAt: T0, lockedUntil: T0 + 5 * MIN });
  await recoverOnStartup(T0 + MIN);
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
  const pub = fakePublisher([{ status: 'published' }], [{ found: true }]);
  await processDue(T0 + MIN, deps(pub));
  expect(pub.calls).toBe(0);
  expect((await db.posts.get('p1'))?.status).toBe('published');
});

test('a post more than 2 h late is still published (retried late, not skipped)', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 121 * MIN, deps(pub));
  expect(pub.calls).toBe(1);
  expect((await db.posts.get('p1'))?.status).toBe('published');
});

test('deferring a post moves its shown time to the real next attempt', async () => {
  await addPost('old', { status: 'published', publishedAt: T0 - 5 * MIN });
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  await processDue(T0, deps(fakePublisher([{ status: 'published' }])));
  expect((await db.posts.get('p1'))?.scheduledAt).toBe(T0 + 55 * MIN);
});

test('min gap defers a post when the platform posted recently', async () => {
  await addPost('old', { status: 'published', publishedAt: T0 - 20 * MIN });
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
  expect((await db.queue.toArray())[0].runAt).toBe(T0 + 40 * MIN);
});

test('duplicate of a post published in the last 7 days is not posted again', async () => {
  await addPost('old', { status: 'published', publishedAt: T0 - 3 * 24 * 60 * MIN, fingerprint: 'sama' });
  await addPost('p1', { fingerprint: 'sama' });
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
  expect((await db.posts.get('p1'))?.error).toMatch(/[Dd]uplicate/);
});

test('cancel removes it from the queue', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  await cancel('p1');
  expect((await db.posts.get('p1'))?.status).toBe('cancelled');
  expect(await db.queue.count()).toBe(0);
});

test('publisher exception is treated as unknown (never as success)', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher(['throw']);
  await processDue(T0, deps(pub));
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
});

test('Asia/Jakarta wall time converts to UTC', () => {
  expect(zonedToUtc('2026-11-10T09:00', 'Asia/Jakarta').toISOString()).toBe('2026-11-10T02:00:00.000Z');
});

test('a processing post whose lock expired (worker died mid-publish) is feed-checked, not blindly reposted', async () => {
  await addPost('p1', { status: 'processing', attempts: 1, scheduledAt: T0 });
  await db.queue.put({ id: 'q1', kind: 'post', platform: 'threads', postId: 'p1', runAt: T0, lockedUntil: T0 + 5 * MIN });
  const pub = fakePublisher([{ status: 'published' }], [{ found: true, url: 'https://t/x' }]);
  await processDue(T0 + 6 * MIN, deps(pub));
  expect(pub.finds).toBe(1);
  expect(pub.calls).toBe(0);
  expect((await db.posts.get('p1'))?.status).toBe('published');
});

test('calendar drag keeps time of day in Asia/Jakarta', async () => {
  const { moveToDay } = await import('@/pages/Calendar');
  const at = Date.parse('2026-11-10T02:30:00Z'); // 09:30 WIB
  expect(moveToDay(at, '2026-11-12', 'Asia/Jakarta').toISOString()).toBe('2026-11-12T02:30:00.000Z');
});

test('[review#2] feed check that errors defers instead of reposting', async () => {
  await addPost('p1', { status: 'verifying', attempts: 1, scheduledAt: T0 });
  await db.queue.put({ id: 'q1', kind: 'post', platform: 'threads', postId: 'p1', runAt: T0 });
  const pub = fakePublisher([{ status: 'published' }]);
  pub.findExisting = vi.fn(async () => { throw new Error('Page load timed out'); });
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
  const p = await db.posts.get('p1');
  expect(p?.status).toBe('verifying');
  expect(p?.attempts).toBe(1);
  expect((await db.queue.toArray())[0].runAt).toBeGreaterThan(T0);
});

test('[review#3] after an ambiguous attempt, a later preflight failure keeps verifying so the feed is checked again', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'unknown' }, { status: 'failed', reason: 'login hiccup' }, { status: 'published' }], [{ found: false }, { found: true, url: 'https://t/late' }]);
  await processDue(T0, deps(pub)); // unknown
  await processDue(T0 + 2 * MIN, deps(pub)); // feed: not found → publish → failed
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
  await processDue(T0 + 12 * MIN, deps(pub)); // must feed-check again → finds attempt 1's post
  expect(pub.finds).toBe(2);
  expect(pub.calls).toBe(2); // no third publish
  expect(await db.posts.get('p1')).toMatchObject({ status: 'published', url: 'https://t/late' });
});

test('[review#5] missed manual posts are not superseded — both go out (gap enforced)', async () => {
  await addPost('a');
  await addPost('b');
  await schedulePost('a', new Date(T0));
  await schedulePost('b', new Date(T0 + 30 * MIN));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 60 * MIN, deps(pub));
  expect((await db.posts.get('a'))?.status).toBe('published');
  expect((await db.posts.get('b'))?.status).toBe('scheduled'); // deferred by min gap, not failed
});

test('[review#6] lock is refreshed right before publishing', async () => {
  const t = Date.now();
  await addPost('p1');
  await schedulePost('p1', new Date(t));
  let lockAtPublish: number | undefined;
  const pub = fakePublisher([{ status: 'published' }]);
  pub.publish = vi.fn(async () => {
    lockAtPublish = (await db.queue.toArray())[0]?.lockedUntil;
    return { status: 'published' as const };
  });
  await processDue(t, deps(pub));
  expect(lockAtPublish).toBeGreaterThanOrEqual(t + 9 * MIN);
});

test('identical text waits while an earlier copy is still verifying (no duplicate on the feed)', async () => {
  await addPost('orig', { status: 'verifying', attempts: 1, fingerprint: 'sama persis' });
  await addPost('copy', { fingerprint: 'sama persis' });
  await schedulePost('copy', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
  expect((await db.posts.get('copy'))?.status).toBe('scheduled');
  expect((await db.queue.where('postId').equals('copy').first())!.runAt).toBeGreaterThan(T0);
});

test('closing the automation tab cancels the post without retry', async () => {
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'cancelled', reason: 'Cancelled: you closed the SocialPilot tab before posting.' }]);
  await processDue(T0, deps(pub));
  expect(await db.posts.get('p1')).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/closed/) });
  expect(await db.queue.count()).toBe(0);
});

test('Publish now (immediate) skips the minimum gap', async () => {
  await addPost('old', { status: 'published', publishedAt: T0 - 5 * MIN });
  await addPost('p1');
  await schedulePost('p1', new Date(T0), { immediate: true });
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(1);
});

test('gap wait is explained on the post', async () => {
  await addPost('old', { status: 'published', publishedAt: T0 - 5 * MIN });
  await addPost('p1');
  await schedulePost('p1', new Date(T0));
  await processDue(T0, deps(fakePublisher([{ status: 'published' }])));
  expect((await db.posts.get('p1'))?.error).toMatch(/Waiting: min 60 min gap/);
});

test('scheduled posts without a queue item are re-queued', async () => {
  const { repairOrphans } = await import('@/services/publishing/PublishingQueue');
  await addPost('p1', { status: 'scheduled', scheduledAt: T0 - 3 * 60 * MIN });
  await addPost('p2');
  await schedulePost('p2', new Date(T0 + MIN));
  expect(await repairOrphans(T0)).toBe(1);
  expect((await db.queue.where('postId').equals('p1').first())?.runAt).toBe(T0);
  expect(await repairOrphans(T0)).toBe(0);
});

test('posts previously skipped for being late are re-queued', async () => {
  const { repairOrphans } = await import('@/services/publishing/PublishingQueue');
  await addPost('p1', { status: 'failed', error: 'Skipped: more than 2 h late (Chrome was closed)', scheduledAt: T0 - 300 * MIN });
  expect(await repairOrphans(T0)).toBe(1);
  expect(await db.posts.get('p1')).toMatchObject({ status: 'scheduled', scheduledAt: T0 });
});

test('a paused group is switched off and its waiting posts move to another group', async () => {
  await db.groups.bulkAdd([
    { id: 'g1', name: 'Paused', url: 'https://www.facebook.com/groups/1', rules: '', enabled: true },
    { id: 'g2', name: 'Live', url: 'https://www.facebook.com/groups/2', rules: '', enabled: true },
  ]);
  await addPost('p1', { platform: 'fbgroup', groupId: 'g1' });
  await addPost('p2', { platform: 'fbgroup', groupId: 'g1' });
  await schedulePost('p1', new Date(T0));
  await schedulePost('p2', new Date(T0 + 120 * MIN));
  const pub = fakePublisher([{ status: 'failed', reason: 'Group is paused by its admin — nobody can post.' }]);
  await processDue(T0, deps(pub));
  expect(await db.groups.get('g1')).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/paused/) });
  expect((await db.posts.get('p2'))?.groupId).toBe('g2');
  expect((await db.posts.get('p1'))?.groupId).toBe('g2');
});

test('a group post that keeps failing moves once to another group; ambiguous ones never move', async () => {
  await db.groups.bulkAdd([
    { id: 'g1', name: 'Flaky', url: 'https://www.facebook.com/groups/1', rules: '', enabled: true },
    { id: 'g2', name: 'Live', url: 'https://www.facebook.com/groups/2', rules: '', enabled: true },
  ]);
  await addPost('p1', { platform: 'fbgroup', groupId: 'g1', attempts: 3 });
  await schedulePost('p1', new Date(T0));
  await db.posts.update('p1', { attempts: 3 });
  const pub = fakePublisher([{ status: 'failed', reason: 'Post button not found' }]);
  await processDue(T0, deps(pub));
  const p = await db.posts.get('p1');
  expect(p).toMatchObject({ groupId: 'g2', status: 'scheduled', attempts: 0, groupsTried: ['g1'] });
  expect(await db.groups.get('g1')).toMatchObject({ enabled: true }); // a temporary error does not switch the group off
  expect(await db.queue.where('postId').equals('p1').count()).toBe(1);

  // Second group fails too → no third move, the post fails.
  await db.posts.update('p1', { attempts: 3 });
  await processDue(T0 + 3 * 60 * MIN, deps(fakePublisher([{ status: 'failed', reason: 'Post button not found' }])));
  expect((await db.posts.get('p1'))?.status).toBe('failed');
});

test('replies do not hold up normal posts, and the same short reply to different comments is not a duplicate', async () => {
  await addPost('r1', { text: 'Terima kasih kak!', fingerprint: 'tk', replyTo: 'https://www.threads.com/@a/post/1', status: 'published', publishedAt: T0 - 60_000 });
  await addPost('r2', { text: 'Terima kasih kak!', fingerprint: 'tk', replyTo: 'https://www.threads.com/@b/post/2' });
  await addPost('root', {});
  await schedulePost('r2', new Date(T0 + 11 * MIN));
  await schedulePost('root', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }], [{ found: true, url: 'https://www.threads.com/@x/post/9' }]);
  await processDue(T0, deps(pub));
  expect((await db.posts.get('root'))?.status).toBe('published'); // the reply 1 min ago did not defer it
  await processDue(T0 + 11 * MIN, deps(pub));
  expect((await db.posts.get('r2'))?.status).not.toBe('failed'); // not rejected as a duplicate of r1
});

test('an unclear group post is never resent; found on the pending page → published as pending', async () => {
  await db.groups.add({ id: 'g1', name: 'G', url: 'https://www.facebook.com/groups/1', rules: '', enabled: true });
  await addPost('p1', { platform: 'fbgroup', groupId: 'g1' });
  await schedulePost('p1', new Date(T0));
  const pub = fakePublisher([{ status: 'unknown', reason: 'Composer did not close' }], [{ found: false }]);
  await processDue(T0, deps(pub));
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
  // Next check: still not visible → keeps checking, never publishes again.
  await processDue(T0 + 3 * 60 * MIN, deps(pub));
  expect(pub.calls).toBe(1);
  expect((await db.posts.get('p1'))?.status).toBe('verifying');
  // Then it shows up among the pending posts.
  const later = fakePublisher([{ status: 'published' }], [{ found: true, pending: true } as never]);
  await processDue(T0 + 6 * 60 * MIN, deps(later));
  expect(later.calls).toBe(0);
  expect(await db.posts.get('p1')).toMatchObject({ status: 'published', note: expect.stringMatching(/admin approval/) });
});
