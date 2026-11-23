// @vitest-environment jsdom
import { automaticComments } from '@/services/autopilot/comments';
import { addCommentIdeas, commentIdeas, commentQuery } from '@/services/autopilot/commentIdeas';
import { DEFAULT_SETTINGS } from '@/services/storage/settings';
import { db, resetDb, seedIfEmpty } from '@/services/storage/db';
import type { RouterLike } from '@/services/content/generate';

const now = Date.parse('2026-11-09T05:00:00Z');
const HALF_HOUR = 31 * 60_000;
const idea = (id: string, title: string) => ({ id, title, body: 'Catatan pesanan' });
const answer = (relevant: boolean): RouterLike => ({
  generate: async () => ({ text: JSON.stringify({ relevant, confidence: 0.98, comment: 'Pisahkan catatan setiap pelanggan agar mudah dicek.' }), providerId: 'ollama', modelId: 'test', latencyMs: 1 }),
});
const found = (q: string) => [{ query: q, posts: [{ text: 'Bagaimana mencatat cucian agar tidak tertukar?', url: 'https://www.threads.com/@owner/post/abc', engagement: 10 }] }];

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  await seedIfEmpty();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), autopilot: { ...structuredClone(DEFAULT_SETTINGS.autopilot), enabled: true } };
  await chrome.storage.local.set({ settings });
  await db.accounts.add({ id: 'a', platform: 'threads', name: 'me', profileUrl: 'https://www.threads.com/@me' });
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => vi.restoreAllMocks());

test('an idea title becomes a short query that names the business field', () => {
  const industry = 'Laundry Management Software';
  expect(commentQuery('Kelola Banyak Outlet? Pola Manajemen Transaksi', industry)).toBe('outlet laundry');
  expect(commentQuery('Cara Menjaga Konsistensi Pencatatan Laundry Sehari-hari', industry)).toBe('konsistensi pencatatan laundry');
  expect(commentQuery('Tips Membantu Karyawan Laundry Ikut Proses Operasional', industry)).toBe('karyawan proses laundry');
});

test('a title of only common words still gives a query', () => {
  expect(commentQuery('Cara dan Tips', '')).toBe('Cara dan Tips');
});

test('adding the same idea twice keeps one entry', async () => {
  await addCommentIdeas([idea('1', 'Catatan laundry')]);
  await addCommentIdeas([idea('1', 'Catatan laundry')]);
  expect(await commentIdeas()).toHaveLength(1);
});

test('a selected idea drives the search and leaves the list once its reply is queued', async () => {
  await addCommentIdeas([idea('1', 'Catatan laundry'), idea('2', 'Karyawan laundry')]);
  const scrape = vi.fn(async (q: string[]) => found(q[0]));
  await automaticComments(now, { router: answer(true), scrape });
  expect(scrape.mock.calls[0][0]).toEqual(['catatan laundry']);
  expect(await db.posts.count()).toBe(1);
  expect((await commentIdeas()).map((i) => i.id)).toEqual(['2']);
});

test('an idea without a relevant post is dropped after 3 searches', async () => {
  await addCommentIdeas([idea('1', 'Catatan laundry')]);
  const scrape = vi.fn(async (q: string[]) => found(q[0]));
  for (let i = 0; i < 3; i++) await automaticComments(now + i * HALF_HOUR, { router: answer(false), scrape });
  expect(await commentIdeas()).toHaveLength(0);
  expect(scrape).toHaveBeenCalledTimes(3);
});

test('selected ideas wait while automatic comments are switched off', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, comments: { ...settings.comments, enabled: false } } });
  await addCommentIdeas([idea('1', 'Catatan laundry')]);
  const scrape = vi.fn(async (q: string[]) => found(q[0]));
  await automaticComments(now, { router: answer(true), scrape });
  expect(scrape).not.toHaveBeenCalled();
  expect(await commentIdeas()).toHaveLength(1);
});
