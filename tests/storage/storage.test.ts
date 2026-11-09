import { db, seedIfEmpty, resetDb } from '@/services/storage/db';
import { exportAll, importAll } from '@/services/storage/exportImport';
import { getSettings, updateSettings } from '@/services/storage/settings';
import type { Post } from '@/types/models';

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

const post = (id: string): Post => ({
  id,
  platform: 'threads',
  accountId: 'a1',
  text: 'Halo laundry 🧺\nbaris dua',
  mediaIds: [],
  status: 'draft',
  fingerprint: 'halo laundry baris dua',
  source: 'manual',
  attempts: 0,
  createdAt: 1,
  updatedAt: 1,
});

test('seed creates one CuciQu Pro brand', async () => {
  await seedIfEmpty();
  await seedIfEmpty();
  const brands = await db.brands.toArray();
  expect(brands).toHaveLength(1);
  expect(brands[0].name).toBe('CuciQu Pro');
  expect(brands[0].website).toBe('https://cuciqu.com/');
  expect(brands[0].affiliateUrl).toBe('https://app.cuciqu.com/');
});

test('export then import round-trips posts', async () => {
  await db.posts.add(post('p1'));
  const blob = await exportAll();
  await resetDb();
  expect(await db.posts.count()).toBe(0);
  await importAll(blob);
  const p = await db.posts.get('p1');
  expect(p?.text).toBe('Halo laundry 🧺\nbaris dua');
});

test('invalid import rejects without writing', async () => {
  await db.posts.add(post('keep'));
  const bad = new Blob([JSON.stringify({ version: 1, posts: [{ id: 5 }] })]);
  await expect(importAll(bad)).rejects.toThrow();
  expect(await db.posts.count()).toBe(1);
});

test('settings defaults and partial update', async () => {
  const s = await getSettings();
  expect(s.timezone).toBe('Asia/Jakarta');
  expect(s.minGapMinutes).toBe(60);
  expect(s.router.mode).toBe('auto');
  expect(s.router.priority).toEqual(['ollama', 'nvidia', 'openrouter']);
  expect(s.autopilot.enabled).toBe(false);
  await updateSettings({ language: 'en' });
  const s2 = await getSettings();
  expect(s2.language).toBe('en');
  expect(s2.timezone).toBe('Asia/Jakarta');
});

describe('full backup (move to the new extension ID)', () => {
  test('posts, media files and settings round-trip; API keys only when chosen', async () => {
    await db.posts.add(post('p1'));
    await db.media.add({ id: 'm1', name: 'a.png', type: 'image/png', size: 3, blob: new Blob(['png'], { type: 'image/png' }), tags: ['x'], usedCount: 0, createdAt: 1 });
    await updateSettings({ minGapMinutes: 77, providers: { nvidia: { apiKey: 'nvapi-SECRET' } } } as never);

    const plain = await exportAll();
    const text = await plain.text();
    expect(text).not.toContain('nvapi-SECRET');

    await resetDb();
    await chrome.storage.local.clear();
    const r = await importAll(plain);
    expect(r).toEqual({ posts: 1, media: 1, settings: true });
    expect((await db.posts.get('p1'))?.text).toBe('Halo laundry 🧺\nbaris dua');
    const m = await db.media.get('m1');
    expect(m?.tags).toEqual(['x']);
    expect(await new Response(m!.blob!).text()).toBe('png');
    expect((await getSettings()).minGapMinutes).toBe(77);
    expect((await getSettings()).providers.nvidia.apiKey).toBeUndefined();

    await updateSettings({ providers: { nvidia: { apiKey: 'nvapi-SECRET' } } } as never);
    const withKeys = await exportAll({ includeApiKeys: true });
    await chrome.storage.local.clear();
    await importAll(withKeys);
    expect((await getSettings()).providers.nvidia.apiKey).toBe('nvapi-SECRET');
  });

  test('a backup without keys never wipes the keys already on this device', async () => {
    const backup = await exportAll();
    await updateSettings({ providers: { nvidia: { apiKey: 'already-here' } } } as never);
    await importAll(backup);
    expect((await getSettings()).providers.nvidia.apiKey).toBe('already-here');
  });

  test('old (version 1) backups still import', async () => {
    const v1 = new Blob([JSON.stringify({ version: 1, posts: [post('old')] })]);
    expect((await importAll(v1)).posts).toBe(1);
    expect(await db.posts.get('old')).toBeDefined();
  });
});
