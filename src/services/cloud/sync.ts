/**
 * Two-way sync between the local Dexie database (+ settings) and Firestore.
 *
 * - Local edits are marked dirty by Dexie hooks (one chrome.storage key per record → no write races between the
 *   dashboard, popup and service worker). Writes made by the sync engine itself run in a quiet transaction and are
 *   never marked (see quiet.ts).
 * - Push is conditional: a record is written only if the cloud copy is older (compare-and-set), so a stale device can
 *   never overwrite a newer edit.
 * - Pull uses the SERVER write time as cursor, so clock differences and late uploads never hide a record.
 * - Conflicts: newest edit wins — except that a published post is never turned back into an unpublished one
 *   (that is what could cause a post to be published twice).
 * - First sign-in on a device: pull first, then upload only what the cloud does not have yet.
 * - Media files go to Google Drive (drive.ts); only metadata is synced. AI API keys are end-to-end encrypted.
 * - Not synced (device-local by design): queue, logs, AI usage, model cache.
 */
import type { Table } from 'dexie';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import type { MediaItem, Post, ProviderId, Settings } from '@/types/models';
import { changedSince, putRecordIfNewer, type RemoteRecord } from './firestore';
import { getPassphrase, open, seal, type Sealed } from './crypto';
import { getSession } from './config';
import { trashMedia, uploadMedia } from './drive';
import { isQuiet, quietly } from './quiet';

export const SYNC_TABLES = ['brands', 'knowledge', 'accounts', 'media', 'ideas', 'posts', 'groups', 'topics'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];
const isSyncTable = (t: string): t is SyncTable => (SYNC_TABLES as readonly string[]).includes(t);

const DIRTY = 'dirty:';
/** Drive files of deleted media, moved to the Drive trash on the next sync */
const TRASH = 'driveTrash:';
const LAST_PULL = 'syncLastPull';
const LAST_UID = 'syncUid';
const SETTINGS_ID = 'main';
export const SYNC_STATUS_KEY = 'syncStatus';
/** Set when Google Drive refused the upload because the Drive permission was not granted. */
export const DRIVE_CONSENT_KEY = 'driveNeedsConsent';
/** Max Drive uploads per sync round (the rest follow next round, so publishing is never held up for long). */
const UPLOADS_PER_ROUND = 5;

let hooksInstalled = false;

const mark = (table: string, id: string, ts = Date.now()) => chrome.storage.local.set({ [`${DIRTY}${table}:${id}`]: ts }).catch(() => undefined);

/** Call once in every context that writes to the database (dashboard, popup, service worker). */
export function installSyncHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const t of SYNC_TABLES) {
    const table = db.table(t) as Table<{ id: string }, string>;
    table.hook('creating', function (key, obj, trans) {
      if (!isQuiet(trans)) void mark(t, String(key ?? obj.id));
    });
    table.hook('updating', function (mods, key, _obj, trans) {
      if (isQuiet(trans)) return undefined;
      void mark(t, String(key));
      // A replaced media file must be uploaded again: forget the old Drive copy.
      if (t === 'media' && 'blob' in (mods as object)) return { driveFileId: undefined };
      return undefined;
    });
    table.hook('deleting', function (key, obj, trans) {
      if (isQuiet(trans)) return;
      void mark(t, String(key));
      const fileId = t === 'media' ? (obj as { driveFileId?: string }).driveFileId : undefined;
      if (fileId) void chrome.storage.local.set({ [`${TRASH}${fileId}`]: Date.now() }).catch(() => undefined);
    });
  }
}

/** JSON of the settings last written by a pull: that write must not be pushed back (no ping-pong between devices). */
let lastPulledSettings = '';

/** Marks settings dirty (called from chrome.storage.onChanged in the service worker with the new value). */
export function markSettingsDirty(newValue: unknown): void {
  if (JSON.stringify(newValue) === lastPulledSettings) return;
  void mark('settings', SETTINGS_ID);
}

/** Re-encrypts and re-uploads the settings (after the passphrase was set or changed). */
export function resealSettings(): void {
  void mark('settings', SETTINGS_ID);
}

/** Pull everything again (e.g. after entering the passphrase on a new device). */
export async function resetPull(): Promise<void> {
  await chrome.storage.local.set({ [LAST_PULL]: '' });
}

async function keysWith(prefix: string): Promise<string[]> {
  return Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(prefix));
}

async function dirtyEntries(): Promise<{ key: string; table: string; id: string; ts: number }[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(DIRTY))
    .map(([key, ts]) => {
      const rest = key.slice(DIRTY.length);
      const i = rest.indexOf(':');
      return { key, table: rest.slice(0, i), id: rest.slice(i + 1), ts: Number(ts) };
    })
    .sort((a, b) => a.ts - b.ts);
}

// ---------- account handling ----------

/**
 * Compares the signed-in account with the one this device synced with before.
 * 'switched' = local data belongs to ANOTHER Google account (must not be uploaded into this one).
 */
export async function accountState(uid: string): Promise<'first' | 'same' | 'switched'> {
  const last = (await chrome.storage.local.get(LAST_UID))[LAST_UID] as string | undefined;
  return !last ? 'first' : last === uid ? 'same' : 'switched';
}

/** Removes the local copy of synced data (posts, brand, groups…) and all pending sync marks. Settings are kept. */
export async function wipeLocalSyncedData(): Promise<void> {
  await quietly(SYNC_TABLES.map((t) => db.table(t)), async () => {
    for (const t of SYNC_TABLES) await db.table(t).clear();
  });
  await chrome.storage.local.remove([...(await keysWith(DIRTY)), ...(await keysWith(TRASH)), LAST_PULL, LAST_UID]);
}

/**
 * First sync of this device with an account: receive everything from the cloud first (cloud wins over stale local
 * copies), then upload only the local records the cloud does not have.
 */
export async function firstSync(uid: string): Promise<{ received: number; uploaded: number }> {
  await chrome.storage.local.remove([...(await keysWith(DIRTY)), LAST_PULL]);
  const seen = new Set<string>();
  const received = await pull({ seen, maxPages: 1000 });
  const now = Date.now();
  const marks: Record<string, number> = {};
  if (!seen.has(`settings:${SETTINGS_ID}`)) marks[`${DIRTY}settings:${SETTINGS_ID}`] = now;
  for (const t of SYNC_TABLES)
    for (const k of await db.table(t).toCollection().primaryKeys()) if (!seen.has(`${t}:${String(k)}`)) marks[`${DIRTY}${t}:${String(k)}`] = now;
  await chrome.storage.local.set({ ...marks, [LAST_UID]: uid });
  return { received, uploaded: Object.keys(marks).length };
}

// ---------- settings (secrets encrypted) ----------

type SyncedSettings = Omit<Settings, 'providers'> & {
  providers: Record<ProviderId, Omit<Settings['providers'][ProviderId], 'apiKey'>>;
  sealedKeys?: Sealed;
};

export async function settingsForCloud(s: Settings, passphrase: string | null): Promise<SyncedSettings> {
  const keys: Partial<Record<ProviderId, string>> = {};
  const providers = {} as SyncedSettings['providers'];
  for (const [id, p] of Object.entries(s.providers) as [ProviderId, Settings['providers'][ProviderId]][]) {
    const { apiKey, ...rest } = p;
    if (apiKey) keys[id] = apiKey;
    providers[id] = rest;
  }
  // Without a passphrase the keys simply stay on this device (never uploaded in clear text).
  const sealedKeys = passphrase && Object.keys(keys).length ? await seal(keys, passphrase) : undefined;
  return { ...s, providers, sealedKeys };
}

export async function settingsFromCloud(remote: SyncedSettings, local: Settings, passphrase: string | null): Promise<{ settings: Settings; keysLocked: boolean }> {
  let keys: Partial<Record<ProviderId, string>> = {};
  let keysLocked = false;
  if (remote.sealedKeys) {
    if (!passphrase) keysLocked = true;
    else keys = await open<Partial<Record<ProviderId, string>>>(remote.sealedKeys, passphrase).catch(() => ((keysLocked = true), {}));
  }
  const { sealedKeys: _s, ...rest } = remote;
  const providers = {} as Settings['providers'];
  for (const [id, p] of Object.entries(rest.providers) as [ProviderId, SyncedSettings['providers'][ProviderId]][]) {
    // Ollama runs on this computer: its address stays device-local.
    providers[id] = { ...p, apiKey: keys[id] ?? local.providers[id]?.apiKey, ...(id === 'ollama' ? { baseUrl: local.providers.ollama.baseUrl } : {}) };
  }
  return { settings: { ...(rest as Omit<Settings, 'providers'>), providers }, keysLocked };
}

// ---------- push / pull ----------

/** A published post must never become unpublished again through sync (that could publish it twice). */
export function isDowngrade(local: Post | undefined, incoming: Post | null): boolean {
  return !!local && local.status === 'published' && (!incoming || incoming.status !== 'published');
}

async function serialize(table: string, id: string, uploads: { left: number }): Promise<{ json: string; deleted: boolean } | 'later'> {
  if (table === 'settings') {
    return { json: JSON.stringify(await settingsForCloud(await getSettings(), await getPassphrase())), deleted: false };
  }
  let row = (await db.table(table).get(id)) as Record<string, unknown> | undefined;
  if (!row) return { json: 'null', deleted: true };
  if (table === 'media') {
    let m = row as unknown as MediaItem;
    if (!m.driveFileId && m.blob) {
      if (uploads.left <= 0) return 'later';
      uploads.left--;
      let fileId: string;
      try {
        fileId = await uploadMedia(m);
        await chrome.storage.local.remove(DRIVE_CONSENT_KEY);
      } catch (e) {
        // Drive permission not granted (checkbox left unticked on Google's consent screen): sync everything else,
        // keep the media for later, and ask the user once to allow Google Drive.
        if (/\b403\b|insufficient/i.test((e as Error).message)) {
          await chrome.storage.local.set({ [DRIVE_CONSENT_KEY]: true });
          uploads.left = 0;
          return 'later';
        }
        throw e;
      }
      await quietly([db.media], () => db.media.update(m.id, { driveFileId: fileId }));
      m = { ...m, driveFileId: fileId };
    }
    const { blob: _b, ...meta } = m;
    row = { ...meta, thumb: m.thumb && m.thumb.length < 200_000 ? m.thumb : undefined };
  }
  return { json: JSON.stringify(row), deleted: false };
}

/** Pushes dirty records until `deadline`. Returns the number written to the cloud. */
export async function push(deadline = Date.now() + 60_000): Promise<number> {
  let n = 0;
  const uploads = { left: UPLOADS_PER_ROUND };
  for (const d of await dirtyEntries()) {
    if (Date.now() > deadline) break;
    if (d.table !== 'settings' && !isSyncTable(d.table)) {
      await chrome.storage.local.remove(d.key);
      continue;
    }
    const body = await serialize(d.table, d.id, uploads);
    if (body === 'later') continue;
    const res = await putRecordIfNewer({ table: d.table, id: d.id, ts: d.ts, ...body });
    const clear = async () => {
      // Only clear the mark if nothing changed again while we were uploading.
      const cur = (await chrome.storage.local.get(d.key))[d.key];
      if (Number(cur) === d.ts) await chrome.storage.local.remove(d.key);
    };
    if (res.result === 'written') {
      await clear();
      n++;
    } else if (res.result === 'remote-newer') {
      // The cloud has a newer edit: take it (or, if ours is the published one, re-assert it as newer next round).
      const local = d.table === 'posts' ? ((await db.posts.get(d.id)) as Post | undefined) : undefined;
      const remote = res.remote.deleted ? null : (JSON.parse(res.remote.json) as Post);
      if (d.table === 'posts' && isDowngrade(local, remote)) await mark(d.table, d.id, res.remote.ts + 1);
      else {
        await clear();
        await applyRemote(res.remote, true);
      }
    }
    // 'conflict': someone wrote at the same moment — keep the mark and try again next round.
  }
  for (const k of await keysWith(TRASH)) {
    if (Date.now() > deadline) break;
    await trashMedia(k.slice(TRASH.length));
    await chrome.storage.local.remove(k);
  }
  return n;
}

async function applyRemote(r: RemoteRecord, force = false): Promise<'applied' | 'kept-local' | 'skipped'> {
  const key = `${DIRTY}${r.table}:${r.id}`;
  const localTs = Number((await chrome.storage.local.get(key))[key] ?? 0);
  if (!force && localTs > r.ts) return 'kept-local';
  if (r.table === 'settings') {
    if (r.deleted) return 'skipped';
    const res = await settingsFromCloud(JSON.parse(r.json) as SyncedSettings, await getSettings(), await getPassphrase());
    lastPulledSettings = JSON.stringify(res.settings);
    await chrome.storage.local.set({ settings: res.settings, cloudKeysLocked: res.keysLocked });
  } else if (isSyncTable(r.table)) {
    const table = db.table(r.table);
    const row = r.deleted ? null : (JSON.parse(r.json) as Record<string, unknown>);
    if (r.table === 'posts') {
      const local = (await db.posts.get(r.id)) as Post | undefined;
      if (isDowngrade(local, row as Post | null)) {
        await mark('posts', r.id, r.ts + 1); // our published state wins and is pushed back
        return 'kept-local';
      }
    }
    await quietly([table], async () => {
      if (!row) await table.delete(r.id);
      else {
        if (r.table === 'media') {
          const local = (await db.media.get(r.id)) as MediaItem | undefined;
          // keep the downloaded file if it is still the same Drive file; others are fetched from Drive on use
          if (local?.blob && local.driveFileId === row.driveFileId) row.blob = local.blob;
        }
        await table.put(row);
      }
    });
  } else return 'skipped';
  if (localTs && localTs <= r.ts) await chrome.storage.local.remove(key);
  return 'applied';
}

/** Pulls remote changes since the last pull (server-time cursor). Returns the number applied. */
export async function pull(opts: { seen?: Set<string>; maxPages?: number; deadline?: number } = {}): Promise<number> {
  let since = String((await chrome.storage.local.get(LAST_PULL))[LAST_PULL] ?? '');
  let applied = 0;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const rows = await changedSince(since, 300);
    let advanced = false;
    for (const r of rows) {
      opts.seen?.add(`${r.table}:${r.id}`);
      if ((await applyRemote(r)) === 'applied') applied++;
      if (r.serverTs && r.serverTs > since) {
        since = r.serverTs;
        advanced = true;
      }
    }
    await chrome.storage.local.set({ [LAST_PULL]: since });
    if (rows.length < 300 || !advanced || (opts.deadline && Date.now() > opts.deadline)) break;
  }
  return applied;
}

let running: Promise<void> | null = null;
/**
 * One sync round: pull (so this device publishes from the latest state), then push. Time-boxed so a large first
 * upload never holds up publishing. Safe to call often; does nothing when signed out or after an account switch.
 */
export function syncNow(budgetMs = 45_000): Promise<void> {
  if (running) return running;
  running = (async () => {
    const s = await getSession();
    if (!s) return;
    const state = await accountState(s.uid);
    if (state === 'switched') {
      await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { at: Date.now(), ok: false, error: 'This browser has data of another Google account — open Cloud & Sync to resolve' } });
      return;
    }
    try {
      if (state === 'first') await firstSync(s.uid);
      const deadline = Date.now() + budgetMs;
      const pulled = await pull({ deadline });
      const pushed = await push(deadline);
      await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { at: Date.now(), ok: true, pushed, pulled } });
      if (pushed || pulled) await log('info', 'cloud', `Sync: ${pushed} sent, ${pulled} received`);
    } catch (e) {
      await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { at: Date.now(), ok: false, error: (e as Error).message } });
      await log('warn', 'cloud', `Sync failed: ${(e as Error).message}`);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
