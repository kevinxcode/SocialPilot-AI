/**
 * Minimal Firestore REST client (no SDK: works in the MV3 service worker).
 * Layout per user:  users/{uid}/records/{table}__{id}  { table, id, json, ts, deleted }
 *                   users/{uid}/meta/{name}            { json, ts }
 * Security rules (see docs/SETUP-CLOUD.md) only let a signed-in user read/write under users/{their uid}.
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
  return {
    root: `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents`,
    user: `users/${t.uid}`,
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
  };
}

async function call<T>(f: Fetch, url: string, init: RequestInit): Promise<T> {
  const r = await f(url, init);
  if (r.status === 404) return null as T;
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new FirestoreError(`Firestore ${r.status}: ${(j as { error?: { message?: string } }).error?.message ?? 'request failed'}`, r.status);
  return j;
}

export const docId = (table: string, id: string) => `${table}__${id}`.replace(/\//g, '_');

function toRecord(d: FsDoc): RemoteRecord {
  const f = d.fields ?? {};
  return {
    table: f.table?.stringValue ?? '',
    id: f.id?.stringValue ?? '',
    json: f.json?.stringValue ?? 'null',
    ts: Number(f.ts?.integerValue ?? 0),
    deleted: !!f.deleted?.booleanValue,
  };
}

export async function putRecord(rec: RemoteRecord, f: Fetch = fetch): Promise<void> {
  const b = await base(f);
  await call(f, `${b.root}/${b.user}/records/${encodeURIComponent(docId(rec.table, rec.id))}`, {
    method: 'PATCH',
    headers: b.headers,
    body: JSON.stringify({
      fields: {
        table: { stringValue: rec.table },
        id: { stringValue: rec.id },
        json: { stringValue: rec.json },
        ts: { integerValue: String(rec.ts) },
        deleted: { booleanValue: rec.deleted },
      },
    }),
  });
}

/** All records changed after `since` (ms), oldest first, max `limit`. */
export async function changedSince(since: number, limit = 300, f: Fetch = fetch): Promise<RemoteRecord[]> {
  const b = await base(f);
  const rows = await call<{ document?: FsDoc }[]>(f, `${b.root}/${b.user}:runQuery`, {
    method: 'POST',
    headers: b.headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'records' }],
        where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN', value: { integerValue: String(since) } } },
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
        limit,
      },
    }),
  });
  return (rows ?? []).filter((r) => r.document).map((r) => toRecord(r.document!));
}

/** Reads a meta document; returns its JSON value and updateTime (for compare-and-set). */
export async function getMeta<T>(name: string, f: Fetch = fetch): Promise<{ value: T; updateTime: string } | null> {
  const b = await base(f);
  const d = await call<FsDoc | null>(f, `${b.root}/${b.user}/meta/${encodeURIComponent(name)}`, { method: 'GET', headers: b.headers });
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
    if (e instanceof FirestoreError && (e.status === 400 || e.status === 409 || e.status === 412) && ifUpdateTime !== undefined) return false;
    throw e;
  }
}
