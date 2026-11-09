import type { RemoteRecord } from '@/services/cloud/firestore';

const remote = new Map<string, RemoteRecord>();
vi.mock('@/services/cloud/firestore', () => ({
  putRecord: vi.fn(async (r: RemoteRecord) => void remote.set(`${r.table}__${r.id}`, r)),
  changedSince: vi.fn(async (since: number) => [...remote.values()].filter((r) => r.ts > since).sort((a, b) => a.ts - b.ts)),
}));
vi.mock('@/services/cloud/drive', () => ({
  uploadMedia: vi.fn(async () => 'DRIVE1'),
  trashMedia: vi.fn(async () => undefined),
}));

import { installSyncHooks, markAllDirty, markSettingsDirty, pull, push } from '@/services/cloud/sync';
import { trashMedia } from '@/services/cloud/drive';
import { db, resetDb } from '@/services/storage/db';
import { getSettings, updateSettings } from '@/services/storage/settings';
import type { Post } from '@/types/models';

const flush = () => new Promise((r) => setTimeout(r, 0));
const post = (id: string, text = `teks ${id}`): Post => ({
  id, platform: 'threads', accountId: 'a', text, mediaIds: [], status: 'draft', fingerprint: id, source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0,
});

beforeAll(() => installSyncHooks());
beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  remote.clear();
});

test('local changes are pushed; the dirty mark is cleared', async () => {
  await db.posts.add(post('p1'));
  await flush();
  expect(await push()).toBe(1);
  expect(JSON.parse(remote.get('posts__p1')!.json)).toMatchObject({ id: 'p1', text: 'teks p1' });
  expect(await push()).toBe(0);
});

test('a deletion is pushed as a tombstone and applied on the other device', async () => {
  await db.posts.add(post('p1'));
  await flush();
  await push();
  await db.posts.delete('p1');
  await flush();
  await push();
  expect(remote.get('posts__p1')!.deleted).toBe(true);
  // other device has it
  await chrome.storage.local.clear();
  await db.posts.put(post('p1'));
  await chrome.storage.local.clear(); // its own put is not a newer local edit
  await pull();
  expect(await db.posts.get('p1')).toBeUndefined();
});

test('pulled records are applied without being marked dirty (no ping-pong)', async () => {
  remote.set('posts__p9', { table: 'posts', id: 'p9', json: JSON.stringify(post('p9', 'dari laptop lain')), ts: 100, deleted: false });
  expect(await pull()).toBe(1);
  await flush();
  expect((await db.posts.get('p9'))?.text).toBe('dari laptop lain');
  expect(await push()).toBe(0);
  expect(await pull()).toBe(0); // already seen
});

test('conflict: a newer local edit wins over an older remote one', async () => {
  await db.posts.add(post('p1', 'lokal terbaru'));
  await flush();
  remote.set('posts__p1', { table: 'posts', id: 'p1', json: JSON.stringify(post('p1', 'remote lama')), ts: 1, deleted: false });
  await pull();
  expect((await db.posts.get('p1'))?.text).toBe('lokal terbaru');
  await push();
  expect(JSON.parse(remote.get('posts__p1')!.json).text).toBe('lokal terbaru');
});

test('media: the file goes to Drive, only metadata goes to Firestore; local file kept on pull; delete trashes the Drive file', async () => {
  await db.media.add({ id: 'm1', name: 'a.png', type: 'image/png', size: 3, blob: new Blob(['png']), tags: ['kasir'], usedCount: 0, createdAt: 1 });
  await flush();
  await push();
  const meta = JSON.parse(remote.get('media__m1')!.json);
  expect(meta).toMatchObject({ id: 'm1', driveFileId: 'DRIVE1' });
  expect(meta.blob).toBeUndefined();
  expect((await db.media.get('m1'))?.driveFileId).toBe('DRIVE1');
  // a remote metadata change does not drop the local file
  remote.set('media__m1', { ...remote.get('media__m1')!, json: JSON.stringify({ ...meta, tags: ['baru'] }), ts: Date.now() + 1000 });
  await pull();
  const m = await db.media.get('m1');
  expect(m?.tags).toEqual(['baru']);
  expect(m?.blob).toBeDefined();
  await db.media.delete('m1');
  await flush();
  await push();
  expect(trashMedia).toHaveBeenCalledWith('DRIVE1');
});

test('settings: a pulled change is not pushed back; a real local change is', async () => {
  const s = await getSettings();
  remote.set('settings__main', { table: 'settings', id: 'main', json: JSON.stringify({ ...s, minGapMinutes: 77 }), ts: 50, deleted: false });
  await pull();
  const pulled = await getSettings();
  expect(pulled.minGapMinutes).toBe(77);
  markSettingsDirty(pulled); // what onChanged reports after the pull
  await flush();
  expect(await push()).toBe(0);
  await updateSettings({ minGapMinutes: 45 });
  markSettingsDirty(await getSettings());
  await flush();
  expect(await push()).toBe(1);
  expect(JSON.parse(remote.get('settings__main')!.json).minGapMinutes).toBe(45);
});

test('first sign-in uploads everything that exists locally', async () => {
  await db.posts.bulkAdd([post('a'), post('b')]);
  await db.groups.add({ id: 'g', name: 'G', url: 'https://www.facebook.com/groups/g', rules: '', enabled: true });
  await chrome.storage.local.clear();
  expect(await markAllDirty()).toBe(4); // 2 posts + 1 group + settings
  await push();
  expect([...remote.keys()].sort()).toEqual(['groups__g', 'posts__a', 'posts__b', 'settings__main']);
});
