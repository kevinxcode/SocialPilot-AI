import { generateInstagramCaption, parseImageCaption } from '@/services/content/generate';
import { db, resetDb, seedIfEmpty } from '@/services/storage/db';
import type { GenerateRequest } from '@/services/ai/AIRouter';

beforeEach(async () => {
  await resetDb();
  await seedIfEmpty();
});

test('the image is sent to a VISION model together with the brand knowledge, and JSON is parsed', async () => {
  let req: GenerateRequest | undefined;
  const router = {
    generate: vi.fn(async (r: GenerateRequest) => {
      req = r;
      return { text: '```json\n{"caption":"Cucian rapi, pelanggan senang.","hashtags":["laundry","#cuciqu"]}\n```', providerId: 'ollama' as const, modelId: 'qwen2.5vl' };
    }),
  };
  const brandId = (await db.brands.toCollection().first())!.id;
  const r = await generateInstagramCaption('data:image/jpeg;base64,AAAA', { brandId, language: 'id', hint: 'promo outlet baru' }, { router });
  expect(r.caption).toBe('Cucian rapi, pelanggan senang.');
  expect(r.hashtags).toEqual(['#laundry', '#cuciqu']);
  expect(req!.needsVision).toBe(true);
  const user = req!.messages.find((m) => m.role === 'user')!;
  expect(user.images).toEqual(['data:image/jpeg;base64,AAAA']);
  expect(user.content).toMatch(/promo outlet baru/);
  expect(user.content).toMatch(/Instagram/);
  expect(req!.messages[0].role).toBe('system'); // brand context
});

test('parse: hashtags written inside the caption are moved to the list; plain-text answers still work', () => {
  expect(parseImageCaption('{"caption":"Halo kak! #promo #laundry","hashtags":["#cuciqu"]}')).toEqual({ caption: 'Halo kak!', hashtags: ['#cuciqu', '#promo', '#laundry'] });
  expect(parseImageCaption('Laundry jadi gampang.\n\n#laundry #umkm')).toEqual({ caption: 'Laundry jadi gampang.', hashtags: ['#laundry', '#umkm'] });
  expect(() => parseImageCaption('   ')).toThrow(/empty caption/);
});
