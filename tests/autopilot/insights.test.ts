import { bestMinutes, dailySummary, pickRecyclable, slotMinutes } from '@/services/autopilot/insights';
import { cleanReply, ownReplies } from '@/services/autopilot/ownReplies';
import { pickMediaForText } from '@/services/media/pick';
import { CUCIQU_SEED, db, resetDb } from '@/services/storage/db';
import { updateSettings } from '@/services/storage/settings';
import type { Post } from '@/types/models';

const TZ = 'Asia/Jakarta';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T06:00:00Z'); // 13:00 WIB
const post = (id: string, p: Partial<Post> = {}): Post => ({
  id, platform: 'threads', accountId: 'a', text: `Post ${id}`, mediaIds: [], status: 'published', fingerprint: id, source: 'autopilot',
  attempts: 1, createdAt: NOW, updatedAt: NOW, publishedAt: NOW, ...p,
});

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

test('daily summary counts the day per platform, separates replies, null on an empty day', () => {
  const posts = [
    post('1'), post('2', { platform: 'facebook' }), post('3', { replyTo: 'https://x' }),
    post('4', { status: 'failed', updatedAt: NOW }), post('5', { engagement: 9, text: 'Nota hilang bikin pusing' }),
    post('old', { publishedAt: NOW - 2 * DAY }),
  ];
  const s = dailySummary(posts, '2026-11-10', TZ)!;
  expect(s.title).toBe('SocialPilot today: 3 posts, 1 failed');
  expect(s.message).toMatch(/Threads 2, Facebook Page 1/);
  expect(s.message).toMatch(/1 replies/);
  expect(s.message).toMatch(/♥ 9\): Nota hilang/);
  expect(dailySummary(posts, '2026-11-01', TZ)).toBeNull();
});

test('best hours need enough data, then rank hours by average engagement inside the window', () => {
  const at = (h: number) => Date.parse(`2026-11-0${5}T${String(h - 7).padStart(2, '0')}:10:00Z`); // h in WIB
  const few = [post('a', { engagement: 5, publishedAt: at(10) })];
  expect(bestMinutes(few, TZ, 9 * 60, 19 * 60, NOW)).toBeNull();
  const many = [
    ...[1, 2, 3].map((i) => post(`m${i}`, { engagement: 2, publishedAt: at(10) })),
    ...[1, 2, 3].map((i) => post(`e${i}`, { engagement: 20, publishedAt: at(19) })), // outside 09-19 window end
    ...[1, 2, 3].map((i) => post(`n${i}`, { engagement: 10, publishedAt: at(12) })),
  ];
  expect(bestMinutes(many, TZ, 9 * 60, 19 * 60, NOW)).toEqual([12 * 60 + 15, 10 * 60 + 15]);
});

test('slots: half go to best hours, rest stay spread, all ≥45 min apart; no data → even spread', () => {
  expect(slotMinutes(2, 540, 1140, null)).toEqual([690, 990]);
  const m = slotMinutes(4, 540, 1140, [735, 615]);
  expect(m).toHaveLength(4);
  expect(m).toContain(735);
  expect(m).toContain(615);
  for (let i = 1; i < m.length; i++) expect(m[i] - m[i - 1]).toBeGreaterThanOrEqual(45);
});

test('recycle picks the best old Threads post with real engagement, never recent / replies / already recycled', () => {
  const old = NOW - 40 * DAY;
  const posts = [
    post('recent', { engagement: 50 }),
    post('reply', { engagement: 40, publishedAt: old, replyTo: 'x' }),
    post('done', { engagement: 30, publishedAt: old, recycledAt: NOW - DAY }),
    post('low', { engagement: 1, publishedAt: old }),
    post('win', { engagement: 12, publishedAt: old }),
  ];
  expect(pickRecyclable(posts, 'threads', NOW)?.id).toBe('win');
  expect(pickRecyclable(posts.filter((p) => p.id !== 'win'), 'threads', NOW)).toBeUndefined();
});

test('AI image pick uses the chosen number and falls back on nonsense', async () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  await db.media.bulkAdd([
    { id: 'm1', name: 'kasir.png', type: 'image/png', size: 1, blob, tags: ['kasir'], usedCount: 0, createdAt: 1 },
    { id: 'm2', name: 'setrika.png', type: 'image/png', size: 1, blob, tags: ['setrika'], usedCount: 0, createdAt: 2 },
  ]);
  const r = (text: string) => ({ generate: vi.fn(async () => ({ text })) });
  expect((await pickMediaForText('Tips setrika', [], r('2')))?.id).toBe('m2');
  expect((await pickMediaForText('Tips setrika', ['kasir'], r('none')))?.id).toBe('m1'); // tag fallback
});

test('cleanReply drops SKIP, links and JSON', () => {
  expect(cleanReply('"Terima kasih kak, semoga membantu!"')).toBe('Terima kasih kak, semoga membantu!');
  expect(cleanReply('SKIP')).toBeNull();
  expect(cleanReply('Cek https://x.com')).toBeNull();
  expect(cleanReply('{"reply":"x"}')).toBeNull();
});

describe('replies to comments on our own posts', () => {
  const parentUrl = 'https://www.threads.com/@cuciqu.pro/post/AAA';
  beforeEach(async () => {
    await db.brands.add({ ...CUCIQU_SEED, id: 'b1', createdAt: 0, updatedAt: 0 });
    await db.accounts.add({ id: 'a', platform: 'threads', name: 'cuciqu.pro', profileUrl: 'https://www.threads.com/@cuciqu.pro' });
    await updateSettings({ activeBrandId: 'b1', autopilot: { enabled: true, windowStart: '09:00', windowEnd: '19:00' } });
    await db.posts.add(post('p', { url: parentUrl, publishedAt: NOW - 3600_000, text: 'Tips nota laundry' }));
  });
  const scraped = [
    { text: 'Tips nota laundry', url: parentUrl, engagement: 3 },
    { text: 'budi 1j Aplikasinya bisa dipakai di HP?', url: 'https://www.threads.com/@budi/post/BBB', engagement: 0 },
    { text: 'cuciqu.pro 1j Bisa kak', url: 'https://www.threads.com/@cuciqu.pro/post/CCC', engagement: 0 },
    { text: 'spam 1j follow me', url: 'https://www.threads.com/@spam/post/DDD', engagement: 0 },
  ];

  test('answers new comments once, skips our own replies and SKIPped comments', async () => {
    const router = { generate: vi.fn(async (req: { messages: { content: string }[] }) => ({ text: req.messages[1].content.includes('follow me') ? 'SKIP' : 'Bisa kak, CuciQu Pro bisa dipakai di HP.', providerId: 'ollama' as const, modelId: 'm' })) };
    const n = await ownReplies(NOW, { router: router as never, scrape: async () => scraped });
    expect(n).toBe(1);
    const reply = (await db.posts.toArray()).find((p) => p.replyKind === 'own')!;
    expect(reply).toMatchObject({ replyTo: 'https://www.threads.com/@budi/post/BBB', status: 'scheduled' });
    expect(await db.queue.where('postId').equals(reply.id).count()).toBe(1);
    expect(router.generate).toHaveBeenCalledTimes(2); // budi + spam; never our own reply

    // Next scan (2 h later, after the reply was published): nothing new, the AI is not asked again.
    await db.posts.update(reply.id, { status: 'published' });
    router.generate.mockClear();
    expect(await ownReplies(NOW + 2 * 3600_000 + 1, { router: router as never, scrape: async () => scraped })).toBe(0);
    expect(router.generate).not.toHaveBeenCalled();
  });

  test('off, outside the window, or within 2 h of the last scan → nothing happens', async () => {
    const router = { generate: vi.fn() };
    const scrape = vi.fn(async () => scraped);
    await updateSettings({ autopilot: { ownReplies: false } });
    expect(await ownReplies(NOW, { router: router as never, scrape })).toBe(0);
    await updateSettings({ autopilot: { ownReplies: true } });
    expect(await ownReplies(Date.parse('2026-11-10T14:00:00Z'), { router: router as never, scrape })).toBe(0); // 21:00 WIB
    expect(scrape).not.toHaveBeenCalled();
  });
});
