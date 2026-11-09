/**
 * Minimal Firestore REST client (no SDK: works in the MV3 service worker).
 * Layout per user:  users/{uid}/records/{table}__{id}  { table, id, json, ts, deleted, serverTs }
 *                   users/{uid}/meta/{name}            { json, ts }
 * - `ts`       = client time of the edit, used for conflict resolution (newest edit wins).
 * - `serverTs` = server time of the write (REQUEST_TIME transform), used as the pull cursor so clock differences
 *                between devices and late uploads can never hide a record.
 * - Writes are conditional (compare-and-set on the document's updateTime): an older edit can never overwrite a newer one.
 * Security rules (docs/SETUP-CLOUD.md) only let a signed-in user read/write under users/{their uid}.
 */
import { getCloudConfig } from './config';
import { idToken } from './auth';

type Fetch = typeof fetch;

export interface RemoteRecord {
  table: string;
  id: string;
  json: string;
  ts: number;
  deleted: boolean;
  /** server write time (ISO), set by Firestore */
  serverTs?: string;
}

type FsValue = { stringValue?: string; integerValue?: string; booleanValue?: boolean; timestampValue?: string };
interface FsDoc {
  name: string;
  fields?: Record<string, FsValue>;
  updateTime?: string;
}

export class FirestoreError extends Error {
  name = 'FirestoreError';
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function base(f: Fetch) {
  const cfg = await getCloudConfig();
  if (!cfg) throw new FirestoreError('Cloud is not configured', 0);
  const t = await idToken(f);
  const db = `projects/${encodeURIComponent(cfg.projectId)}/databases/(default)`;
  return {
    api: 'https://firestore.googleapis.com/v1',
    db,
    root: `https://firestore.googleapis.com/v1/${db}/documents`,
    docs: `${db}/documents`,
    user: `users/${t.uid}`,
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
  };
}

/** HTTP call; 404 → null only when `allow404` (plain reads). Every other error throws (never a silent "success"). */
async function call<T>(f: Fetch, url: string, init: RequestInit, allow404 = false): Promise<T> {
  const r = await f(url, init);
  if (r.status === 404 && allow404) return null as T;
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new FirestoreError(`Firestore ${r.status}: ${(j as { error?: { message?: string } }).error?.message ?? 'request failed'}`, r.status);
  return j;
}

/** Document ids are base64url, so any record id is a valid, unambiguous Firestore id. */
export const docId = (table: string, id: string) => `${table}__${btoa(unescape(encodeURIComponent(id))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

function toRecord(d: FsDoc): RemoteRecord {
  const f = d.fields ?? {};
  return {
    table: f.table?.stringValue ?? '',
    id: f.id?.stringValue ?? '',
    json: f.json?.stringValue ?? 'null',
    ts: Number(f.ts?.integerValue ?? 0),
    deleted: !!f.deleted?.booleanValue,
    serverTs: f.serverTs?.timestampValue,
  };
}

const fields = (rec: RemoteRecord) => ({
  table: { stringValue: rec.table },
  id: { stringValue: rec.id },
  json: { stringValue: rec.json },
  ts: { integerValue: String(rec.ts) },
  deleted: { booleanValue: rec.deleted },
});

export async function getRecord(table: string, id: string, f: Fetch = fetch): Promise<{ rec: RemoteRecord; updateTime: string } | null> {
  const b = await base(f);
  const d = await call<FsDoc | null>(f, `${b.root}/${b.user}/records/${docId(table, id)}`, { method: 'GET', headers: b.headers }, true);
  return d ? { rec: toRecord(d), updateTime: d.updateTime ?? '' } : null;
}

const isPrecondition = (e: unknown) => e instanceof FirestoreError && (e.status === 400 || e.status === 409 || e.status === 412 || e.status === 404);

/**
 * Writes the record only if the cloud copy is older (by `ts`) — compare-and-set, so a concurrent writer cannot be
 * overwritten. Returns 'written', 'remote-newer' (with the newer remote copy) or 'conflict' (retry later).
 */
export async function putRecordIfNewer(
  rec: RemoteRecord,
  f: Fetch = fetch,
): Promise<{ result: 'written' } | { result: 'remote-newer'; remote: RemoteRecord } | { result: 'conflict' }> {
  const cur = await getRecord(rec.table, rec.id, f);
  if (cur && cur.rec.ts >= rec.ts) return { result: 'remote-newer', remote: cur.rec };
  const b = await base(f);
  try {
    await call(f, `${b.api}/${b.docs}:commit`, {
      method: 'POST',
      headers: b.headers,
      body: JSON.stringify({
        writes: [
          {
            update: { name: `${b.docs}/${b.user}/records/${docId(rec.table, rec.id)}`, fields: fields(rec) },
            updateTransforms: [{ fieldPath: 'serverTs', setToServerValue: 'REQUEST_TIME' }],
            currentDocument: cur ? { updateTime: cur.updateTime } : { exists: false },
          },
        ],
      }),
    });
    return { result: 'written' };
  } catch (e) {
    if (isPrecondition(e)) return { result: 'conflict' };
    throw e;
  }
}

/**
 * Records written by the server after `sinceIso` (minus a 2-minute overlap for in-flight commits), oldest first.
 * Re-applying a record is harmless (it is idempotent), so the overlap only costs a few duplicates.
 */
export async function changedSince(sinceIso: string, limit = 300, f: Fetch = fetch): Promise<RemoteRecord[]> {
  const b = await base(f);
  const from = new Date(Math.max(0, Date.parse(sinceIso || '1970-01-01T00:00:00Z') - 2 * 60_000)).toISOString();
  const rows = await call<{ document?: FsDoc }[]>(f, `${b.root}/${b.user}:runQuery`, {
    method: 'POST',
    headers: b.headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'records' }],
        where: { fieldFilter: { field: { fieldPath: 'serverTs' }, op: 'GREATER_THAN', value: { timestampValue: from } } },
        orderBy: [{ field: { fieldPath: 'serverTs' }, direction: 'ASCENDING' }],
        limit,
      },
    }),
  });
  return (rows ?? []).filter((r) => r.document).map((r) => toRecord(r.document!));
}

/** Reads a meta document; returns its JSON value and updateTime (for compare-and-set). */
export async function getMeta<T>(name: string, f: Fetch = fetch): Promise<{ value: T; updateTime: string } | null> {
  const b = await base(f);
  const d = await call<FsDoc | null>(f, `${b.root}/${b.user}/meta/${encodeURIComponent(name)}`, { method: 'GET', headers: b.headers }, true);
  if (!d) return null;
  return { value: JSON.parse(d.fields?.json?.stringValue ?? 'null') as T, updateTime: d.updateTime ?? '' };
}

/**
 * Writes a meta document. With `ifUpdateTime` the write only succeeds when nobody changed it meanwhile
 * (`null` = only if it does not exist yet). Returns false when that precondition failed.
 */
export async function setMeta(name: string, value: unknown, ifUpdateTime?: string | null, f: Fetch = fetch): Promise<boolean> {
  const b = await base(f);
  const pre =
    ifUpdateTime === undefined ? '' : ifUpdateTime === null ? '?currentDocument.exists=false' : `?currentDocument.updateTime=${encodeURIComponent(ifUpdateTime)}`;
  try {
    await call(f, `${b.root}/${b.user}/meta/${encodeURIComponent(name)}${pre}`, {
      method: 'PATCH',
      headers: b.headers,
      body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(value) }, ts: { integerValue: String(Date.now()) } } }),
    });
    return true;
  } catch (e) {
    if (ifUpdateTime !== undefined && isPrecondition(e)) return false;
    throw e;
  }
}
