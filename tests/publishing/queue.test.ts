import { schedulePost, cancel, processDue, setPaused, recoverOnStartup, zonedToUtc, type QueueDeps , removeDuplicates } from '@/services/publishing/PublishingQueue';
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
    publishers: { threads: pub, facebook: pub, fbgroup: pub, instagram: pub },
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

test('media that cannot be loaded → nothing is posted; a plain retry (not "verifying")', async () => {
  await addPost('m', { mediaIds: ['img1'] });
  await schedulePost('m', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 1000, deps(pub, { loadMedia: async () => { throw new Error('Media file not available on this device'); } }));
  expect(pub.calls).toBe(0);
  expect(await db.posts.get('m')).toMatchObject({ status: 'scheduled', error: 'Media file not available on this device' });
});

test('autopilot paused → its already-scheduled posts wait (nothing posted); manual posts still go; resume → posted', async () => {
  const { updateSettings } = await import('@/services/storage/settings');
  await updateSettings({ autopilot: { enabled: true, paused: true } });
  await addPost('auto', { source: 'autopilot' });
  await addPost('mine', { source: 'manual' });
  await schedulePost('auto', new Date(T0));
  await schedulePost('mine', new Date(T0));
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 1000, deps(pub));
  expect((await db.posts.get('auto'))?.status).toBe('scheduled');
  expect((await db.posts.get('mine'))?.status).toBe('published');
  await updateSettings({ autopilot: { paused: false } });
  await processDue(T0 + 6 * 60 * MIN, deps(pub)); // well after the minimum gap between posts
  expect((await db.posts.get('auto'))?.status).toBe('published');
});

test('pause / resume selected posts: a paused post is never published; resumed → published', async () => {
  await addPost('a');
  await schedulePost('a', new Date(T0));
  expect(await setPaused(['a', 'missing'], true)).toBe(1);
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 1000, deps(pub));
  expect(pub.calls).toBe(0);
  expect(await db.posts.get('a')).toMatchObject({ status: 'scheduled', paused: true });
  expect(await setPaused(['a'], true)).toBe(0); // already paused
  expect(await setPaused(['a'], false, T0 + 2000)).toBe(1);
  expect((await db.posts.get('a'))?.paused).toBeUndefined();
  await processDue(T0 + 10 * MIN, deps(pub));
  expect((await db.posts.get('a'))?.status).toBe('published');
});

test('Instagram: at least 2 hours between two posts, whatever the general gap says', async () => {
  // The queue stamps publishedAt with the real clock, so this test works relative to it.
  const t = Date.now();
  await addPost('ig1', { platform: 'instagram', mediaIds: ['img'], fingerprint: 'laundry rapi tanpa ribet bersama cuciqu' });
  await addPost('ig2', { platform: 'instagram', mediaIds: ['img'], fingerprint: 'cuci kering setrika dalam satu hari saja' });
  await schedulePost('ig1', new Date(t));
  await schedulePost('ig2', new Date(t + MIN)); // after ig1, so the order is fixed
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(t + 2 * MIN, deps(pub));
  expect((await db.posts.get('ig1'))?.status).toBe('published');
  const ig2 = await db.posts.get('ig2');
  expect(ig2).toMatchObject({ status: 'scheduled', error: 'Waiting: min 120 min gap after the last Instagram post' });
  const publishedAt = (await db.posts.get('ig1'))!.publishedAt!;
  expect(ig2!.nextRetryAt).toBe(publishedAt + 120 * MIN);
  await processDue(publishedAt + 60 * MIN, deps(pub));
  expect((await db.posts.get('ig2'))?.status).toBe('scheduled');
  await processDue(publishedAt + 121 * MIN, deps(pub));
  expect((await db.posts.get('ig2'))?.status).toBe('published');
});

test('Instagram cannot be scheduled without exactly one image', async () => {
  await addPost('none', { platform: 'instagram' });
  await addPost('two', { platform: 'instagram', mediaIds: ['a', 'b'] });
  await expect(schedulePost('none', new Date(T0))).rejects.toThrow(/need an image/);
  await expect(schedulePost('two', new Date(T0))).rejects.toThrow(/only one image/);
  expect(await db.queue.count()).toBe(0);
});

test('Instagram: a caption too short to recognise on the profile cannot be scheduled', async () => {
  await addPost('short', { platform: 'instagram', mediaIds: ['img'], fingerprint: 'promo' });
  await expect(schedulePost('short', new Date(T0))).rejects.toThrow(/at least 20 letters/);
});

test('[review#1] Instagram post not found after Share is NEVER posted again automatically', async () => {
  await addPost('igv', { platform: 'instagram', mediaIds: ['img'], fingerprint: 'laundry rapi tanpa ribet bersama cuciqu', status: 'verifying', attempts: 1 });
  await db.queue.add({ id: 'qv', postId: 'igv', kind: 'post', platform: 'instagram', runAt: T0 });
  const pub = fakePublisher([{ status: 'published' }], [{ found: false }]);
  await processDue(T0, deps(pub));
  expect(pub.calls).toBe(0);
  expect(await db.posts.get('igv')).toMatchObject({ status: 'verifying', error: expect.stringMatching(/automatic resend disabled/) });
  for (let i = 1; i <= 4; i++) await processDue(T0 + i * 31 * MIN, deps(pub));
  expect(pub.calls).toBe(0);
  expect(await db.posts.get('igv')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Check your Instagram profile/) });
});

test('[review#5] a paused post keeps its scheduled time, and Resume makes it due at once', async () => {
  await addPost('ps');
  await schedulePost('ps', new Date(T0));
  await setPaused(['ps'], true);
  const pub = fakePublisher([{ status: 'published' }]);
  await processDue(T0 + 1000, deps(pub));
  await processDue(T0 + 6 * MIN, deps(pub));
  expect((await db.posts.get('ps'))?.scheduledAt).toBe(T0);
  await setPaused(['ps'], false, T0 + 7 * MIN);
  expect((await db.queue.where('postId').equals('ps').first())?.runAt).toBe(T0 + 7 * MIN);
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

describe('duplicate guard', () => {
  test('waiting copies of an identical post on the same platform are removed automatically; other platforms are kept', async () => {
    await addPost('live', { text: 'Tips laundry: pisahkan cucian!', fingerprint: 'tips', status: 'published', publishedAt: T0 - 60 * MIN });
    await addPost('copy', { text: 'Tips  laundry: pisahkan cucian!', fingerprint: 'tips' });
    await addPost('fb', { platform: 'facebook', text: 'Tips laundry: pisahkan cucian!', fingerprint: 'tips' });
    await addPost('a1', { text: 'Promo minggu ini untuk pelanggan setia', fingerprint: 'promo' });
    await addPost('a2', { text: 'Promo minggu ini untuk pelanggan setia', fingerprint: 'promo' });
    for (const id of ['copy', 'fb', 'a1', 'a2']) await schedulePost(id, new Date(T0 + 60 * MIN));
    await db.posts.update('a2', { createdAt: 5 });
    const removed = await removeDuplicates(T0);
    expect(removed).toBe(2);
    expect((await db.posts.get('copy'))?.status).toBe('cancelled');
    expect((await db.posts.get('copy'))?.error).toMatch(/Duplicate removed/);
    expect(await db.queue.where('postId').equals('copy').count()).toBe(0);
    expect((await db.posts.get('fb'))?.status).toBe('scheduled');
    expect((await db.posts.get('a1'))?.status).toBe('scheduled'); // the older copy stays
    expect((await db.posts.get('a2'))?.status).toBe('cancelled');
  });

  test('only exact same text counts; same opening but different ending is kept', async () => {
    await addPost('x1', { text: 'Tips laundry hari ini nomor satu', fingerprint: 'f' });
    await addPost('x2', { text: 'Tips laundry hari ini nomor dua', fingerprint: 'f' });
    await schedulePost('x1', new Date(T0));
    await schedulePost('x2', new Date(T0));
    expect(await removeDuplicates(T0)).toBe(0);
  });

  test('replies: the same text to different comments is not a duplicate; to the same comment it is', async () => {
    await addPost('r1', { text: 'Terima kasih kak!', replyTo: 'https://www.threads.com/@a/post/1' });
    await addPost('r2', { text: 'Terima kasih kak!', replyTo: 'https://www.threads.com/@b/post/2' });
    await addPost('r3', { text: 'Terima kasih kak!', replyTo: 'https://www.threads.com/@a/post/1', createdAt: 9 });
    for (const id of ['r1', 'r2', 'r3']) await schedulePost(id, new Date(T0));
    expect(await removeDuplicates(T0)).toBe(1);
    expect((await db.posts.get('r3'))?.status).toBe('cancelled');
  });

  test('a copy reaching publish time is cancelled (not failed)', async () => {
    await addPost('live', { text: 'Sama persis', fingerprint: 'sama', status: 'published', publishedAt: T0 - 60 * MIN });
    await addPost('dup', { text: 'Sama persis', fingerprint: 'sama' });
    await schedulePost('dup', new Date(T0));
    const pub = fakePublisher([{ status: 'published' }]);
    await processDue(T0, deps(pub));
    expect(pub.calls).toBe(0);
    expect((await db.posts.get('dup'))?.status).toBe('cancelled');
  });
});

test('[review#2] the fingerprint describes the text that is really posted (links removed)', async () => {
  const { createDraft, updatePostText } = await import('@/services/publishing/posts');
  const p = await createDraft({ platform: 'instagram', text: 'cuciqu.com laundry rapi tanpa ribet setiap hari', mediaIds: ['m'], autoMedia: false });
  expect(p.text).not.toContain('cuciqu.com');
  expect(p.fingerprint).not.toContain('cuciqu com');
  await updatePostText(p.id, 'www.cuciqu.id cucian wangi dan rapi setiap hari');
  expect((await db.posts.get(p.id))?.fingerprint).toBe('cucian wangi dan rapi setiap hari');
});

test('"Publish now" skips the gap on Threads, but NOT on Instagram (2-hour minimum always applies)', async () => {
  const t = Date.now();
  for (const [id, platform, fp] of [['th1', 'threads', 'a'], ['th2', 'threads', 'b'], ['ig1', 'instagram', 'laundry rapi tanpa ribet bersama cuciqu'], ['ig2', 'instagram', 'cuci kering setrika dalam satu hari saja']] as const) {
    await addPost(id, { platform, mediaIds: platform === 'instagram' ? ['img'] : [], fingerprint: fp });
  }
  const pub = fakePublisher([{ status: 'published' }]);
  await schedulePost('th1', new Date(t));
  await schedulePost('ig1', new Date(t));
  await processDue(t + 1000, deps(pub));
  await schedulePost('th2', new Date(t + 2000), { immediate: true });
  await schedulePost('ig2', new Date(t + 2000), { immediate: true });
  await processDue(t + 3000, deps(pub));
  expect((await db.posts.get('th2'))?.status).toBe('published');
  expect(await db.posts.get('ig2')).toMatchObject({ status: 'scheduled', error: expect.stringMatching(/120 min gap/) });
});

describe('automatic queue (no collisions)', () => {
  test('posts piled on the same minute are spread at the platform gap; order and per-platform gaps kept', async () => {
    const { autoReorder } = await import('@/services/publishing/PublishingQueue');
    for (const id of ['t1', 't2', 't3']) {
      await addPost(id);
      await schedulePost(id, new Date(T0));
    }
    await addPost('g1', { platform: 'fbgroup', groupId: 'g' });
    await addPost('g2', { platform: 'fbgroup', groupId: 'h' });
    await schedulePost('g1', new Date(T0));
    await schedulePost('g2', new Date(T0));
    expect(await autoReorder(T0)).toBe(3); // t2, t3, g2 moved; t1 and g1 keep T0
    const at = async (id: string) => (await db.posts.get(id))!.scheduledAt;
    expect([await at('t1'), await at('t2'), await at('t3')]).toEqual([T0, T0 + 60 * MIN, T0 + 120 * MIN]); // default gap 60
    expect([await at('g1'), await at('g2')]).toEqual([T0, T0 + 30 * MIN]); // group gap 30
    expect((await db.queue.where('postId').equals('t3').first())?.runAt).toBe(T0 + 120 * MIN);
    expect(await autoReorder(T0)).toBe(0); // already in order
  });

  test('a post is never moved EARLIER than its own time; paused posts are not touched', async () => {
    const { autoReorder } = await import('@/services/publishing/PublishingQueue');
    await addPost('late');
    await schedulePost('late', new Date(T0 + 10 * 60 * MIN));
    await addPost('held');
    await schedulePost('held', new Date(T0));
    await setPaused(['held'], true);
    await autoReorder(T0);
    expect((await db.posts.get('late'))?.scheduledAt).toBe(T0 + 10 * 60 * MIN);
    expect((await db.posts.get('held'))?.scheduledAt).toBe(T0);
  });

  test('running it every scheduler cycle never starves a due post (it still gets published)', async () => {
    const { autoReorder } = await import('@/services/publishing/PublishingQueue');
    await addPost('due');
    await schedulePost('due', new Date(T0 - 5 * MIN)); // overdue
    const pub = fakePublisher([{ status: 'published' }]);
    for (let i = 0; i < 3; i++) await autoReorder(T0 + i * MIN);
    await autoReorder(T0 + 3 * MIN);
    await processDue(T0 + 3 * MIN, deps(pub));
    expect((await db.posts.get('due'))?.status).toBe('published');
  });
});

describe('user actions on a "verifying" post', () => {
  test('Mark as published: moves it to published and stops the checks; never while it is being worked on', async () => {
    const { markPublishedByUser } = await import('@/services/publishing/PublishingQueue');
    await addPost('v1', { status: 'verifying', attempts: 1 });
    await db.queue.add({ id: 'q1', postId: 'v1', kind: 'post', platform: 'threads', runAt: T0 });
    await addPost('v2', { status: 'verifying', attempts: 1 });
    await db.queue.add({ id: 'q2', postId: 'v2', kind: 'post', platform: 'threads', runAt: T0, lockedUntil: Date.now() + 60_000 });
    await addPost('done', { status: 'published', publishedAt: 5 });
    expect(await markPublishedByUser(['v1', 'v2', 'done'])).toBe(1);
    expect(await db.posts.get('v1')).toMatchObject({ status: 'published', note: 'Marked as published by you' });
    expect(await db.queue.get('q1')).toBeUndefined();
    expect((await db.posts.get('v2'))?.status).toBe('verifying'); // locked → untouched
    expect((await db.posts.get('done'))?.publishedAt).toBe(5);
  });

  test('Cancel works for a verifying post (nothing is posted), but not while a check is running', async () => {
    await addPost('v3', { status: 'verifying', attempts: 1 });
    await db.queue.add({ id: 'q3', postId: 'v3', kind: 'post', platform: 'threads', runAt: T0 });
    await cancel('v3');
    expect((await db.posts.get('v3'))?.status).toBe('cancelled');
    expect(await db.queue.get('q3')).toBeUndefined();
    await addPost('v4', { status: 'verifying', attempts: 1 });
    await db.queue.add({ id: 'q4', postId: 'v4', kind: 'post', platform: 'threads', runAt: T0, lockedUntil: Date.now() + 60_000 });
    await expect(cancel('v4')).rejects.toThrow(/being published right now/);
  });
});

test('Delete: a "verifying" post waiting for its next check can be deleted; not while it is being worked on', async () => {
  const { deletePost } = await import('@/pages/PostEditor');
  await addPost('vd', { status: 'verifying', attempts: 2 });
  await db.queue.add({ id: 'qd', postId: 'vd', kind: 'post', platform: 'instagram', runAt: T0 + 30 * MIN });
  await deletePost((await db.posts.get('vd'))!);
  expect(await db.posts.get('vd')).toBeUndefined();
  expect(await db.queue.get('qd')).toBeUndefined();
  await addPost('busy', { status: 'verifying', attempts: 2 });
  await db.queue.add({ id: 'qb', postId: 'busy', kind: 'post', platform: 'instagram', runAt: T0, lockedUntil: Date.now() + 60_000 });
  await expect(deletePost((await db.posts.get('busy'))!)).rejects.toThrow(/right now/);
  await addPost('proc', { status: 'processing' });
  await expect(deletePost((await db.posts.get('proc'))!)).rejects.toThrow(/right now/);
});
