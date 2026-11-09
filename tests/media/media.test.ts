import { pickMedia, markUsed } from '@/services/media/pick';
import { importFiles, tagsFromPath } from '@/services/media/importer';
import { db, resetDb } from '@/services/storage/db';
import type { MediaItem } from '@/types/models';

beforeEach(resetDb);

const item = (id: string, p: Partial<MediaItem> = {}): MediaItem => ({
  id, name: `${id}.png`, type: 'image/png', size: 1, blob: new Blob(['x']), tags: [], usedCount: 0, createdAt: 0, ...p,
});

test('pick order: unused tag match → unused any → least recently used → null', async () => {
  expect(await pickMedia(['tips'])).toBeNull();
  await db.media.bulkAdd([
    item('used-tag', { tags: ['tips'], usedCount: 2, lastUsedAt: 500 }),
    item('old-used', { usedCount: 1, lastUsedAt: 100 }),
    item('unused-other', { tags: ['promo'] }),
    item('unused-tag', { tags: ['tips'] }),
    item('video', { type: 'video/mp4', tags: ['tips'] }),
  ]);
  expect((await pickMedia(['tips']))?.id).toBe('unused-tag');
  await markUsed('unused-tag');
  expect((await pickMedia(['tips']))?.id).toBe('unused-other');
  await markUsed('unused-other');
  expect((await pickMedia(['tips']))?.id).toBe('old-used');
  const m = await db.media.get('unused-other');
  expect(m?.usedCount).toBe(1);
  expect(m?.lastUsedAt).toBeGreaterThan(0);
});

test('importFiles stores images and videos, skips other files and duplicates', async () => {
  const f = (name: string, type: string) => new File(['data-' + name], name, { type });
  const r1 = await importFiles([f('promo-kasir.png', 'image/png'), f('notes.txt', 'text/plain'), f('demo.mp4', 'video/mp4')]);
  expect(r1).toEqual({ added: 2, skipped: 1, duplicates: 0 });
  const r2 = await importFiles([f('promo-kasir.png', 'image/png')]);
  expect(r2.duplicates).toBe(1);
  expect(await db.media.count()).toBe(2);
  const img = await db.media.where('name').equals('promo-kasir.png').first();
  expect(img?.tags).toEqual(expect.arrayContaining(['promo', 'kasir']));
});

test('tagsFromPath uses folder names and filename words', () => {
  expect(tagsFromPath('app-marketing/Tips Laundry/feature_kasir-01.jpg')).toEqual(['app', 'marketing', 'tips', 'laundry', 'feature', 'kasir']);
});

test('directory import skips node_modules, .git, hidden and build folders', async () => {
  const file = (name: string, type: string) => ({ kind: 'file' as const, name, getFile: async () => new File(['d' + name], name, { type }) });
  const dir = (name: string, children: unknown[]): unknown => ({
    kind: 'directory' as const,
    name,
    async *values() {
      yield* children;
    },
  });
  const root = dir('app-marketing', [
    file('poster.png', 'image/png'),
    dir('node_modules', [file('logo.png', 'image/png')]),
    dir('.git', [file('x.png', 'image/png')]),
    dir('dist', [file('build.png', 'image/png')]),
    dir('facebook', [file('fb-post.jpg', 'image/jpeg')]),
  ]);
  const r = await importFiles(root as FileSystemDirectoryHandle);
  expect(r.added).toBe(2);
  expect((await db.media.toArray()).map((m) => m.name).sort()).toEqual(['fb-post.jpg', 'poster.png']);
});
test('tagsFromPath handles Windows separators', () => { expect(tagsFromPath('a\\Promo\\kasir.png')).toEqual(['promo', 'kasir']); });
