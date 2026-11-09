/**
 * Two-way sync between the local Dexie database (+ settings) and Firestore.
 *
 * - Local changes are marked dirty by Dexie hooks (one chrome.storage key per record → no write races between the
 *   dashboard, popup and service worker), then pushed by the service worker.
 * - Remote changes are pulled by `ts` and applied without re-marking them dirty.
 * - Conflicts: newest change wins (a local change newer than the remote one is kept and pushed).
 * - Media files are NOT stored in Firestore: they go to Google Drive (see drive.ts); only metadata is synced.
 * - AI API keys are end-to-end encrypted with the user's passphrase before they leave the device.
 * - Not synced (device-local by design): queue, logs, AI usage, model cache.
 */
import type { Table } from 'dexie';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import type { MediaItem, ProviderId, Settings } from '@/types/models';
import { changedSince, putRecord, type RemoteRecord } from './firestore';
import { getPassphrase, open, seal, type Sealed } from './crypto';
import { getSession } from './config';
import { trashMedia, uploadMedia } from './drive';

export const SYNC_TABLES = ['brands', 'knowledge', 'accounts', 'media', 'ideas', 'posts', 'groups', 'topics'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

const DIRTY = 'dirty:';
/** Drive files of deleted media, moved to the Drive trash on the next sync */
const TRASH = 'driveTrash:';
const LAST_PULL = 'syncLastPull';
const SETTINGS_ID = 'main';
export const SYNC_STATUS_KEY = 'syncStatus';

let applyingRemote = false;
let hooksInstalled = false;

const mark = (table: string, id: string) => void chrome.storage.local.set({ [`${DIRTY}${table}:${id}`]: Date.now() }).catch(() => undefined);

/** Call once in every context that writes to the database (dashboard, popup, service worker). */
export function installSyncHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const t of SYNC_TABLES) {
    const table = db.table(t) as Table<{ id: string }, string>;
    table.hook('creating', (key, obj) => {
      if (!applyingRemote) mark(t, String(key ?? obj.id));
    });
    table.hook('updating', (_mods, key) => {
      if (!applyingRemote) mark(t, String(key));
    });
    table.hook('deleting', (key, obj) => {
      if (applyingRemote) return;
      mark(t, String(key));
      const fileId = t === 'media' ? (obj as { driveFileId?: string }).driveFileId : undefined;
      if (fileId) void chrome.storage.local.set({ [`${TRASH}${fileId}`]: Date.now() }).catch(() => undefined);
    });
  }
}

/** JSON of the settings last written by a pull: that write must not be pushed back (no ping-pong between devices). */
let lastPulledSettings = '';

/** Marks settings dirty (called from chrome.storage.onChanged in the service worker with the new value). */
export function markSettingsDirty(newValue: unknown): void {
  if (applyingRemote || JSON.stringify(newValue) === lastPulledSettings) return;
  mark('settings', SETTINGS_ID);
}

/** Re-encrypts and re-uploads the settings (after the passphrase was set or changed). */
export function resealSettings(): void {
  mark('settings', SETTINGS_ID);
}

/** Pull everything again (e.g. after entering the passphrase on a new device). */
export async function resetPull(): Promise<void> {
  await chrome.storage.local.set({ [LAST_PULL]: 0 });
}

/** First sign-in on a device: upload everything that exists locally. */
export async function markAllDirty(): Promise<number> {
  const now = Date.now();
  const entries: Record<string, number> = { [`${DIRTY}settings:${SETTINGS_ID}`]: now };
  for (const t of SYNC_TABLES) for (const k of await db.table(t).toCollection().primaryKeys()) entries[`${DIRTY}${t}:${String(k)}`] = now;
  await chrome.storage.local.set(entries);
  return Object.keys(entries).length;
}

async function dirtyEntries(): Promise<{ key: string; table: string; id: string; ts: number }[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(DIRTY))
    .map(([key, ts]) => {
      const rest = key.slice(DIRTY.length);
      const i = rest.indexOf(':');
      return { key, table: rest.slice(0, i), id: rest.slice(i + 1), ts: Number(ts) };
    });
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
    providers[id] = { ...p, apiKey: keys[id] ?? local.providers[id]?.apiKey };
  }
  return { settings: { ...(rest as Omit<Settings, 'providers'>), providers }, keysLocked };
}

// ---------- push / pull ----------

async function serialize(table: string, id: string): Promise<{ json: string; deleted: boolean }> {
  if (table === 'settings') {
    return { json: JSON.stringify(await settingsForCloud(await getSettings(), await getPassphrase())), deleted: false };
  }
  let row = (await db.table(table).get(id)) as Record<string, unknown> | undefined;
  if (!row) return { json: 'null', deleted: true };
  if (table === 'media') {
    let m = row as unknown as MediaItem;
    if (!m.driveFileId && m.blob) {
      const fileId = await uploadMedia(m);
      applyingRemote = true;
      try {
        await db.media.update(m.id, { driveFileId: fileId });
      } finally {
        applyingRemote = false;
      }
      m = { ...m, driveFileId: fileId };
    }
    const { blob: _b, ...meta } = m;
    row = { ...meta, thumb: m.thumb && m.thumb.length < 200_000 ? m.thumb : undefined };
  }
  return { json: JSON.stringify(row), deleted: false };
}

/** Pushes all dirty records. Returns the number pushed. */
export async function push(): Promise<number> {
  let n = 0;
  for (const d of await dirtyEntries()) {
    if (d.table !== 'settings' && !(SYNC_TABLES as readonly string[]).includes(d.table)) {
      await chrome.storage.local.remove(d.key);
      continue;
    }
    const body = await serialize(d.table, d.id);
    await putRecord({ table: d.table, id: d.id, ts: d.ts, ...body });
    // Only clear the mark if nothing changed again while we were uploading.
    const now = (await chrome.storage.local.get(d.key))[d.key];
    if (Number(now) === d.ts) await chrome.storage.local.remove(d.key);
    n++;
  }
  const all = await chrome.storage.local.get(null);
  for (const k of Object.keys(all).filter((x) => x.startsWith(TRASH))) {
    await trashMedia(k.slice(TRASH.length));
    await chrome.storage.local.remove(k);
  }
  return n;
}

async function applyRemote(r: RemoteRecord): Promise<'applied' | 'kept-local' | 'skipped'> {
  const key = `${DIRTY}${r.table}:${r.id}`;
  const localTs = Number((await chrome.storage.local.get(key))[key] ?? 0);
  if (localTs > r.ts) return 'kept-local';
  applyingRemote = true;
  try {
    if (r.table === 'settings') {
      if (r.deleted) return 'skipped';
      const res = await settingsFromCloud(JSON.parse(r.json) as SyncedSettings, await getSettings(), await getPassphrase());
      lastPulledSettings = JSON.stringify(res.settings);
      await chrome.storage.local.set({ settings: res.settings, cloudKeysLocked: res.keysLocked });
    } else if ((SYNC_TABLES as readonly string[]).includes(r.table)) {
      const table = db.table(r.table);
      if (r.deleted) await table.delete(r.id);
      else {
        const row = JSON.parse(r.json) as Record<string, unknown>;
        if (r.table === 'media') {
          const local = (await db.media.get(r.id)) as MediaItem | undefined;
          if (local?.blob) row.blob = local.blob; // keep the downloaded file; others are fetched from Drive on use
        }
        await table.put(row);
      }
    } else return 'skipped';
  } finally {
    applyingRemote = false;
  }
  if (localTs) await chrome.storage.local.remove(key);
  return 'applied';
}

/** Pulls remote changes since the last pull. Returns the number applied. */
export async function pull(): Promise<number> {
  let since = Number((await chrome.storage.local.get(LAST_PULL))[LAST_PULL] ?? 0);
  let applied = 0;
  for (let page = 0; page < 20; page++) {
    const rows = await changedSince(since, 300);
    for (const r of rows) {
      if ((await applyRemote(r)) === 'applied') applied++;
      since = Math.max(since, r.ts);
    }
    await chrome.storage.local.set({ [LAST_PULL]: since });
    if (rows.length < 300) break;
  }
  return applied;
}

let running: Promise<void> | null = null;
/** One sync round (push then pull). Safe to call often; does nothing when signed out. */
export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    if (!(await getSession())) return;
    try {
      const pushed = await push();
      const pulled = await pull();
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
