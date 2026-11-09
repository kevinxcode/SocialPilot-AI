import { parseVariations, parseIdeas } from '@/services/content/parse';
import { validatePost } from '@/services/content/validate';
import { generateVariations } from '@/services/content/generate';
import { fingerprint } from '@/services/publishing/fingerprint';
import { db, resetDb, CUCIQU_SEED } from '@/services/storage/db';

const v = (i: number) => ({
  title: `T${i}`, hook: 'H', caption: `Caption ${i}`, body: 'B', cta: 'C', hashtags: ['#laundry'], suggestedTime: '19:00', imagePrompt: 'img',
});

beforeEach(async () => {
  await resetDb();
  await db.brands.add({ ...CUCIQU_SEED, id: 'b1', pricing: 'Rp 99.000/bulan', createdAt: 0, updatedAt: 0 });
});

test('parses fenced JSON with variations key', () => {
  const out = parseVariations('Sure!\n```json\n{"variations":[' + [1, 2, 3].map((i) => JSON.stringify(v(i))).join(',') + ']}\n```', 'threads');
  expect(out).toHaveLength(3);
  expect(out[0]).toMatchObject({ title: 'T1', platform: 'threads', hashtags: ['#laundry'] });
});

test('parses bare JSON array and normalises hashtags', () => {
  const raw = JSON.stringify([{ ...v(1), hashtags: 'laundry, #kasir' }]);
  expect(parseVariations(raw, 'facebook')[0].hashtags).toEqual(['#laundry', '#kasir']);
});

test('unparseable output throws a clear error', () => {
  expect(() => parseVariations('I cannot help with that', 'threads')).toThrow(/could not be parsed/i);
});

test('parseIdeas reads list of ideas', () => {
  expect(parseIdeas('```json\n{"ideas":[{"title":"A","body":"b"}]}\n```')).toEqual([{ title: 'A', body: 'b' }]);
});

test('validate rejects empty, 501-char Threads post and unknown price', async () => {
  expect((await validatePost('   ', 'threads', 'b1')).ok).toBe(false);
  const long = await validatePost('a'.repeat(501), 'threads', 'b1');
  expect(long.errors.join()).toMatch(/500/);
  expect((await validatePost('a'.repeat(501), 'facebook', 'b1')).ok).toBe(true);
  const price = await validatePost('Cuma Rp 49.000 sebulan!', 'threads', 'b1');
  expect(price.ok).toBe(false);
  expect(price.errors.join()).toMatch(/rp49000/);
  expect((await validatePost('Mulai Rp99.000/bulan', 'threads', 'b1')).ok).toBe(true);
});

test('validate ignores numbers inside hashtags and URLs, allows small list counts', async () => {
  expect((await validatePost('3 tips laundry #laundry24 https://app.cuciqu.com/r/123', 'threads', 'b1')).ok).toBe(true);
  expect((await validatePost('Naik 80% omzet', 'threads', 'b1')).ok).toBe(false);
});

test('Threads length counts emoji as user-visible characters', async () => {
  expect((await validatePost('🧺'.repeat(500), 'threads', 'b1')).ok).toBe(true);
});

test('generateVariations asks the router and returns 3 parsed variations', async () => {
  const router = { generate: vi.fn(async () => ({ text: JSON.stringify({ variations: [v(1), v(2), v(3)] }), providerId: 'ollama' as const, modelId: 'm' })) };
  const out = await generateVariations(
    { brandId: 'b1', topic: 'antrian laundry', objective: 'awareness', audience: '', language: 'id', platform: 'threads', contentType: 'educational', tone: 'friendly', cta: '', hashtags: '' },
    3,
    { router },
  );
  expect(out).toHaveLength(3);
  const req = (router.generate.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] };
  expect(req.messages[0].content).toContain('CuciQu Pro');
  expect(req.messages[1].content).toMatch(/3 variations/);
});

test('fingerprint normalises case, emoji, urls and whitespace', () => {
  expect(fingerprint('Halo  LAUNDRY 🧺\nhttps://x.y/z  #promo Mantap!')).toBe('halo laundry mantap');
  expect(fingerprint('x'.repeat(100))).toHaveLength(60);
});

test('literal backslash-n from a model becomes a real line break', async () => {
  const { parseVariations } = await import('@/services/content/parse');
  const v = parseVariations(JSON.stringify({ variations: [{ caption: 'Halo?\\n\\nBaris dua' }] }), 'threads');
  expect(v[0].caption).toBe('Halo?\n\nBaris dua');
});
