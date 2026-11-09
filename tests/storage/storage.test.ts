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
