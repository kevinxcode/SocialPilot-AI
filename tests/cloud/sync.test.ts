import type { RemoteRecord } from '@/services/cloud/firestore';

// In-memory "Firestore" with the same semantics as the real client: conditional writes + server-time cursor.
const remote = new Map<string, RemoteRecord>();
let serverClock = Date.parse('2026-11-10T00:00:00Z');
const serverWrite = (r: RemoteRecord) => remote.set(`${r.table}__${r.id}`, { ...r, serverTs: new Date((serverClock += 1000)).toISOString() });
vi.mock('@/services/cloud/firestore', () => ({
  putRecordIfNewer: vi.fn(async (r: RemoteRecord) => {
    const cur = remote.get(`${r.table}__${r.id}`);
    if (cur && cur.ts >= r.ts) return { result: 'remote-newer', remote: cur };
    serverWrite(r);
    return { result: 'written' };
  }),
  changedSince: vi.fn(async (since: string) =>
    [...remote.values()].filter((r) => !since || r.serverTs! > since).sort((a, b) => a.serverTs!.localeCompare(b.serverTs!)),
  ),
}));
vi.mock('@/services/cloud/drive', () => ({
  uploadMedia: vi.fn(async () => 'DRIVE1'),
  trashMedia: vi.fn(async () => undefined),
}));

import { accountState, firstSync, installSyncHooks, markSettingsDirty, pull, push, wipeLocalSyncedData } from '@/services/cloud/sync';
import { quietly } from '@/services/cloud/quiet';
import { trashMedia, uploadMedia } from '@/services/cloud/drive';
import { db, resetDb } from '@/services/storage/db';
import { getSettings, updateSettings } from '@/services/storage/settings';
import type { Post } from '@/types/models';

const flush = () => new Promise((r) => setTimeout(r, 5));
const post = (id: string, p: Partial<Post> = {}): Post => ({
  id, platform: 'threads', accountId: 'a', text: `teks ${id}`, mediaIds: [], status: 'draft', fingerprint: id, source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0, ...p,
});
const dirtyKeys = async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('dirty:'));
const otherDevice = (r: Omit<RemoteRecord, 'serverTs'>) => serverWrite(r);

beforeAll(() => installSyncHooks());
beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  remote.clear();
  vi.mocked(uploadMedia).mockClear();
});

test('local changes are pushed; the dirty mark is cleared', async () => {
  await db.posts.add(post('p1'));
  await flush();
  expect(await push()).toBe(1);
  expect(JSON.parse(remote.get('posts__p1')!.json)).toMatchObject({ id: 'p1', text: 'teks p1' });
  expect(await dirtyKeys()).toEqual([]);
});

test('a deletion is pushed as a tombstone and applied on the other device', async () => {
  await db.posts.add(post('p1'));
  await flush();
  await push();
  await db.posts.delete('p1');
  await flush();
  await push();
  expect(remote.get('posts__p1')!.deleted).toBe(true);
  await quietly([db.posts], () => db.posts.put(post('p1'))); // other device still has it
  await pull();
  expect(await db.posts.get('p1')).toBeUndefined();
});

test('pulled records are not marked dirty (no ping-pong), and are not pulled twice', async () => {
  otherDevice({ table: 'posts', id: 'p9', json: JSON.stringify(post('p9', { text: 'dari laptop lain' })), ts: 100, deleted: false });
  expect(await pull()).toBe(1);
  await flush();
  expect((await db.posts.get('p9'))?.text).toBe('dari laptop lain');
  expect(await dirtyKeys()).toEqual([]);
  expect(await pull()).toBe(0);
});

test('a local edit made WHILE a pull is applying data is still tracked (transaction-scoped quiet mode)', async () => {
  otherDevice({ table: 'posts', id: 'p9', json: JSON.stringify(post('p9')), ts: 100, deleted: false });
  await Promise.all([pull(), db.posts.add(post('mine'))]);
  await flush();
  expect(await dirtyKeys()).toContain('dirty:posts:mine');
});

test('[review#2] clock skew / late upload: a record with an OLD client ts but a new server write is still pulled', async () => {
  otherDevice({ table: 'posts', id: 'a', json: JSON.stringify(post('a')), ts: 9_000_000_000_000, deleted: false }); // device clock far ahead
  await pull();
  otherDevice({ table: 'posts', id: 'late', json: JSON.stringify(post('late')), ts: 1, deleted: false }); // offline device uploads late
  await pull();
  expect(await db.posts.get('late')).toBeDefined();
});

test('[review#1] a stale device cannot overwrite a newer cloud edit; it adopts the newer one instead', async () => {
  otherDevice({ table: 'posts', id: 'p1', json: JSON.stringify(post('p1', { text: 'baru' })), ts: Date.now() + 60_000, deleted: false });
  await db.posts.add(post('p1', { text: 'lama' }));
  await flush();
  await push();
  expect(JSON.parse(remote.get('posts__p1')!.json).text).toBe('baru');
  expect((await db.posts.get('p1'))?.text).toBe('baru');
});

test('[review#1] a published post is never turned back into an unpublished one (no double posting)', async () => {
  // This device published p1. Another device pushes an older "scheduled" copy with a newer client ts.
  await quietly([db.posts], () => db.posts.put(post('p1', { status: 'published', publishedAt: 5 })));
  otherDevice({ table: 'posts', id: 'p1', json: JSON.stringify(post('p1', { status: 'scheduled' })), ts: Date.now() + 60_000, deleted: false });
  await pull();
  expect((await db.posts.get('p1'))?.status).toBe('published');
  await push(); // re-asserted as newer
  expect(JSON.parse(remote.get('posts__p1')!.json).status).toBe('published');
  // …while a published post from the cloud does replace a local scheduled copy.
  await quietly([db.posts], () => db.posts.put(post('p2', { status: 'scheduled' })));
  otherDevice({ table: 'posts', id: 'p2', json: JSON.stringify(post('p2', { status: 'published' })), ts: 1, deleted: false });
  await pull();
  expect((await db.posts.get('p2'))?.status).toBe('published');
});

test('[review#3] first sign-in on a laptop with stale data: the cloud wins, only missing records are uploaded', async () => {
  otherDevice({ table: 'posts', id: 'shared', json: JSON.stringify(post('shared', { status: 'published' })), ts: 50, deleted: false });
  await db.posts.bulkAdd([post('shared', { status: 'scheduled' }), post('onlyHere')]);
  await flush();
  const r = await firstSync('u1');
  expect(r.received).toBe(1);
  expect((await db.posts.get('shared'))?.status).toBe('published');
  await push();
  expect(JSON.parse(remote.get('posts__shared')!.json).status).toBe('published');
  expect(remote.has('posts__onlyHere')).toBe(true);
  expect(await accountState('u1')).toBe('same');
});

test('[review#7] another Google account is detected; wiping removes local data and pending marks', async () => {
  await firstSync('u1');
  expect(await accountState('u2')).toBe('switched');
  await db.posts.add(post('x'));
  await flush();
  await wipeLocalSyncedData();
  expect(await db.posts.count()).toBe(0);
  expect(await dirtyKeys()).toEqual([]);
  expect(await accountState('u2')).toBe('first');
});

test('media: file to Drive, metadata to Firestore; a replaced file is uploaded again; delete trashes the Drive file', async () => {
  await db.media.add({ id: 'm1', name: 'a.png', type: 'image/png', size: 3, blob: new Blob(['png']), tags: [], usedCount: 0, createdAt: 1 });
  await flush();
  await push();
  const meta = JSON.parse(remote.get('media__m1')!.json);
  expect(meta).toMatchObject({ id: 'm1', driveFileId: 'DRIVE1' });
  expect(meta.blob).toBeUndefined();
  expect(await dirtyKeys()).toEqual([]); // storing the Drive id is a quiet write
  await db.media.update('m1', { blob: new Blob(['new']) });
  await flush();
  expect((await db.media.get('m1'))?.driveFileId).toBeUndefined();
  await push();
  expect(uploadMedia).toHaveBeenCalledTimes(2);
  await db.media.delete('m1');
  await flush();
  await push();
  expect(trashMedia).toHaveBeenCalledWith('DRIVE1');
});

test('settings: a pulled change is not pushed back; a real local change is; Ollama address stays local', async () => {
  const s = await getSettings();
  otherDevice({ table: 'settings', id: 'main', json: JSON.stringify({ ...s, minGapMinutes: 77, providers: { ...s.providers, ollama: { ...s.providers.ollama, baseUrl: 'http://other-pc:11434' } } }), ts: 50, deleted: false });
  await pull();
  const pulled = await getSettings();
  expect(pulled.minGapMinutes).toBe(77);
  expect(pulled.providers.ollama.baseUrl).toBe(s.providers.ollama.baseUrl);
  markSettingsDirty(pulled);
  await flush();
  expect(await push()).toBe(0);
  await updateSettings({ minGapMinutes: 45 });
  markSettingsDirty(await getSettings());
  await flush();
  expect(await push()).toBe(1);
  expect(JSON.parse(remote.get('settings__main')!.json).minGapMinutes).toBe(45);
});

test('push is time-boxed and uploads at most 5 media files per round', async () => {
  for (let i = 0; i < 7; i++) await db.media.add({ id: `m${i}`, name: `${i}.png`, type: 'image/png', size: 1, blob: new Blob(['x']), tags: [], usedCount: 0, createdAt: i });
  await flush();
  await push();
  expect(uploadMedia).toHaveBeenCalledTimes(5);
  await push();
  expect(uploadMedia).toHaveBeenCalledTimes(7);
  expect(await push(Date.now() - 1)).toBe(0); // deadline already passed → nothing done
});
