import { cleanTopic, matchPreferred, pickTopic } from '@/services/content/topic';
import { recordTopic, topicForPost, researchTopics } from '@/services/content/topics';
import { db, resetDb } from '@/services/storage/db';

const router = (text: string | Error) => ({
  generate: async () => {
    if (text instanceof Error) throw text;
    return { text } as never;
  },
});

beforeEach(async () => {
  await resetDb();
});

test('cleanTopic strips hashes, quotes, labels and thinking', () => {
  expect(cleanTopic('#Bisnis Laundry')).toBe('Bisnis Laundry');
  expect(cleanTopic('Topic: "UMKM"')).toBe('UMKM');
  expect(cleanTopic('<think>hmm</think>\n\nLaundry Kiloan.')).toBe('Laundry Kiloan');
  expect(cleanTopic('')).toBeNull();
  expect(cleanTopic('x'.repeat(80))).toBeNull();
});

test('matchPreferred keeps the user spelling', () => {
  expect(matchPreferred('bisnis laundry', ['Bisnis Laundry'])).toBe('Bisnis Laundry');
  expect(matchPreferred('UMKM', ['Bisnis Laundry'])).toBe('UMKM');
});

test('pickTopic: AI fails → NO topic (never an unrelated first-in-list topic; real bug 10 Nov)', async () => {
  expect(await pickTopic('teks', ['Bisnis Laundry'], router(new Error('429')))).toBeUndefined();
  expect(await pickTopic('teks', [], router(new Error('429')))).toBeUndefined();
});

test('AI-picked topics are added to the master list automatically and counted', async () => {
  await recordTopic('Bisnis Laundry', 'manual', false);
  expect(await topicForPost({ text: 'a' }, router('UMKM Indonesia'))).toBe('UMKM Indonesia');
  expect(await db.topics.get('umkmindonesia')).toMatchObject({ source: 'ai', uses: 1, enabled: true });
  expect(await topicForPost({ text: 'b' }, router('bisnis laundry'))).toBe('Bisnis Laundry');
  expect((await db.topics.get('bisnislaundry'))?.uses).toBe(1);
});

test('disabled topics are not offered but research skips existing ones', async () => {
  await recordTopic('Laundry', 'manual', false);
  await db.topics.update('laundry', { enabled: false });
  const added = await researchTopics('brand', router('1. Laundry\n2. Bisnis UMKM\n- Usaha Laundry'));
  expect(added).toEqual(['Bisnis UMKM', 'Usaha Laundry']);
});

test('topics used in the last 20 h are not offered again', async () => {
  const seen: string[] = [];
  const spy = { generate: async (req: { messages: { content: string }[] }) => (seen.push(req.messages[1].content), { text: 'x' }) as never };
  await recordTopic('Bisnis Laundry', 'manual', true, 1000);
  await recordTopic('UMKM', 'manual', false);
  await topicForPost({ text: 'a' }, spy as never, 2000);
  expect(seen[0]).toMatch(/UMKM/);
  expect(seen[0]).not.toMatch(/Bisnis Laundry/);
});

test('pickTopic tells the AI to use a listed topic only when it matches the post', async () => {
  const seen: string[] = [];
  const spy = { generate: async (req: { messages: { content: string }[] }) => (seen.push(req.messages[1].content), { text: 'Laporan Laundry' }) as never };
  expect(await pickTopic('Laporan bulanan siap cetak', ['Jadwal pegawai mobile'], spy as never)).toBe('Laporan Laundry');
  expect(seen[0]).toMatch(/ONLY if it clearly matches/);
});
