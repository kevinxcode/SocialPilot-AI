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

test('pickTopic falls back to the first preferred topic when the AI fails', async () => {
  expect(await pickTopic('teks', ['Bisnis Laundry'], router(new Error('429')))).toBe('Bisnis Laundry');
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
