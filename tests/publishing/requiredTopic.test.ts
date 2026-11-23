import { schedulePost, processDue, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { db, resetDb } from '@/services/storage/db';
import { updateSettings } from '@/services/storage/settings';
import type { Publisher } from '@/services/publishing/Publisher';
import type { Post } from '@/types/models';

const T0 = Date.parse('2026-11-10T03:00:00Z');

function publisher() {
  return {
    platform: 'threads' as const,
    preflight: async () => ({ ok: true }),
    publish: vi.fn(async () => ({ status: 'published' as const, url: 'https://t/1' })),
    findExisting: vi.fn(async () => ({ found: false })),
  };
}
const deps = (pub: Publisher, pickTopic: QueueDeps['pickTopic']): QueueDeps => ({
  publishers: { threads: pub, facebook: pub, fbgroup: pub, instagram: pub },
  notify: () => undefined,
  loadMedia: async () => [],
  pickTopic,
});
async function addPost(p: Partial<Post> = {}) {
  await db.posts.put({ id: 'p', platform: 'threads', accountId: 'a', text: 'teks', mediaIds: [], status: 'draft', fingerprint: 'teks', source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0, ...p });
  await schedulePost('p', new Date(T0));
}

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

test('a Threads post with no topic is held and retried, never published', async () => {
  await addPost();
  const pub = publisher();
  await processDue(T0 + 1000, deps(pub, async () => undefined));
  expect(pub.publish).not.toHaveBeenCalled();
  const post = await db.posts.get('p');
  expect(post).toMatchObject({ status: 'scheduled', attempts: 1 });
  expect(post?.error).toMatch(/topic/i);
});

test('after the last retry the post fails with the reason, still unpublished', async () => {
  await addPost();
  const pub = publisher();
  const d = deps(pub, async () => { throw new Error('AI down'); });
  for (let i = 0; i < 6; i++) {
    const next = (await db.queue.toArray())[0]?.runAt;
    if (next) await processDue(next + 1000, d);
  }
  expect(pub.publish).not.toHaveBeenCalled();
  const post = await db.posts.get('p');
  expect(post?.status).toBe('failed');
  expect(post?.error).toMatch(/topic/i);
});

test('a chosen topic goes out with the post', async () => {
  await addPost();
  const pub = publisher();
  await processDue(T0 + 1000, deps(pub, async () => 'Laundry Threads'));
  expect(pub.publish).toHaveBeenCalledTimes(1);
  expect(await db.posts.get('p')).toMatchObject({ status: 'published', topic: 'Laundry Threads' });
});

test('replies do not need a topic', async () => {
  await updateSettings({ autopilot: { enabled: true, platforms: { threads: true, facebook: false, fbgroup: false, instagram: false } } });
  await addPost({ replyTo: 'https://www.threads.com/@x/post/abc', replyTargetText: 'x' });
  const pub = publisher();
  await processDue(T0 + 1000, deps(pub, async () => undefined));
  expect(pub.publish).toHaveBeenCalledTimes(1);
});
