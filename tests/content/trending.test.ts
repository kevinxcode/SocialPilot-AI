import { parseIdeas, researchTrending, takeTrendingIdea, maybeDailyTrending } from '@/services/content/trending';
import { parseCount } from '@/services/publishing/rpa/engine';
import { recordTopic } from '@/services/content/topics';
import { db, resetDb } from '@/services/storage/db';

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

test('parseCount handles K / rb / plain numbers', () => {
  expect(parseCount('15')).toBe(15);
  expect(parseCount('1,2K')).toBe(1200);
  expect(parseCount('3.4rb')).toBe(3400);
  expect(parseCount('Like')).toBe(0);
});

test('parseIdeas reads TITLE | ANGLE | TOPIC lines', () => {
  expect(parseIdeas('<think>x</think>\n1. Judul A | Sudut A | #Bisnis Laundry\nnoise\n- Judul B | Sudut B')).toEqual([
    { title: 'Judul A', body: 'Sudut A', topic: 'Bisnis Laundry' },
    { title: 'Judul B', body: 'Sudut B', topic: undefined },
  ]);
});

test('research scrapes top topics, saves ideas and new topics', async () => {
  await recordTopic('Bisnis Laundry', 'manual', false);
  let queries: string[] = [];
  const ideas = await researchTrending(
    {
      scrape: async (q) => ((queries = q), [{ query: q[0], posts: [{ text: 'laundry ramai banget hari ini kenapa ya semua orang', engagement: 50 }] }]),
      router: { generate: async () => ({ text: 'Ide 1 | Sudut 1 | Laundry Kiloan\nIde 2 | Sudut 2 | UMKM' }) as never },
    },
    { id: 'b1', name: 'CuciQu', summary: 'laundry' },
    1000,
  );
  expect(queries).toEqual(['Bisnis Laundry']);
  expect(ideas).toHaveLength(2);
  expect((await db.ideas.toArray()).filter((i) => i.kind === 'trending')).toHaveLength(2);
  expect(await db.topics.get('laundrykiloan')).toBeTruthy();
});

test('no posts found → error, nothing saved', async () => {
  await expect(
    researchTrending({ scrape: async () => [], router: { generate: async () => ({ text: '' }) as never } }, { id: 'b1', name: 'x', summary: '' }),
  ).rejects.toThrow(/No Threads posts/);
  expect(await db.ideas.count()).toBe(0);
});

test('takeTrendingIdea returns newest fresh idea once', async () => {
  await db.ideas.bulkAdd([
    { id: 'a', brandId: 'b', title: 'old', body: '', kind: 'trending', createdAt: 1000 },
    { id: 'c', brandId: 'b', title: 'new', body: '', kind: 'trending', createdAt: 2000 },
  ]);
  expect((await takeTrendingIdea('b', 3000))?.title).toBe('new');
  expect((await takeTrendingIdea('b', 3000))?.title).toBe('old');
  expect(await takeTrendingIdea('b', 3000)).toBeUndefined();
});

test('daily research runs once per day', async () => {
  let n = 0;
  const run = async () => void n++;
  expect(await maybeDailyTrending('2026-11-09', run)).toBe(true);
  expect(await maybeDailyTrending('2026-11-09', run)).toBe(false);
  expect(await maybeDailyTrending('2026-11-10', run)).toBe(true);
  expect(n).toBe(2);
});
