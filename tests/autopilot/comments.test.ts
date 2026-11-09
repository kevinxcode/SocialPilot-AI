// @vitest-environment jsdom
import { commentBudget, automaticComments } from '@/services/autopilot/comments';
import { DEFAULT_SETTINGS } from '@/services/storage/settings';
import { db, resetDb, seedIfEmpty } from '@/services/storage/db';
import type { RouterLike } from '@/services/content/generate';
import type { Post } from '@/types/models';

const now = Date.parse('2026-11-09T05:00:00Z');
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), autopilot: { ...structuredClone(DEFAULT_SETTINGS.autopilot), enabled: true } });
function reply(patch: Partial<Post> = {}): Post {
  return { id: 'r', accountId: 'a', platform: 'threads', text: 'Useful reply', mediaIds: [], status: 'published', fingerprint: 'usefulreply', source: 'autopilot', attempts: 1, createdAt: now - 2 * 3600_000, updatedAt: now, replyTo: 'https://www.threads.com/@x/post/abc', ...patch };
}

test('automatic comments follow master pause, platform and working window', () => {
  const s = settings();
  expect(commentBudget(s, [], now)).toBe(true);
  s.autopilot.paused = true;
  expect(commentBudget(s, [], now)).toBe(false);
  s.autopilot.paused = false;
  s.autopilot.platforms.threads = false;
  expect(commentBudget(s, [], now)).toBe(false);
  expect(commentBudget(settings(), [], Date.parse('2026-11-09T21:00:00Z'))).toBe(false);
});

test('daily cap, gap and unresolved replies prevent another comment', () => {
  expect(commentBudget(settings(), [reply(), reply(), reply()], now)).toBe(false);
  expect(commentBudget(settings(), [reply({ publishedAt: now - 1000 })], now)).toBe(false);
  expect(commentBudget(settings(), [reply({ status: 'verifying' })], now)).toBe(false);
  expect(commentBudget(settings(), [reply()], now)).toBe(true);
});

test('malformed limits fail closed', () => {
  const s = settings();
  s.comments.dailyLimit = NaN;
  expect(commentBudget(s, [], now)).toBe(false);
});

test('crawler schedules one validated reply and overlapping scans cannot duplicate it', async () => {
  await resetDb();
  await chrome.storage.local.clear();
  await seedIfEmpty();
  await chrome.storage.local.set({ settings: settings() });
  await db.accounts.add({ id: 'a', platform: 'threads', name: 'me', profileUrl: 'https://www.threads.com/@me' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const router: RouterLike = { generate: async () => ({ text: JSON.stringify({ relevant: true, confidence: 0.98, comment: 'Pisahkan catatan setiap pelanggan agar mudah dicek.' }), providerId: 'ollama', modelId: 'test', latencyMs: 1 }) };
  const scrape = async () => [{ query: 'laundry', posts: [
    { text: 'Own post should never be a reply target', url: 'https://www.threads.com/@me/post/own', engagement: 100 },
    { text: 'Bagaimana mencatat cucian agar tidak tertukar?', url: 'https://www.threads.com/@owner/post/abc', engagement: 10 },
  ] }];
  try {
    await Promise.all([automaticComments(now, { router, scrape }), automaticComments(now, { router, scrape })]);
    const posts = await db.posts.toArray();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ replyTo: 'https://www.threads.com/@owner/post/abc', status: 'scheduled', mediaIds: [] });
    expect(await db.queue.count()).toBe(1);
    await automaticComments(now + 31 * 60_000, { router, scrape });
    expect(await db.posts.count()).toBe(1);
  } finally { clock.mockRestore(); }
});
