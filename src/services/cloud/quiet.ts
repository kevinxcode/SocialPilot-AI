/**
 * Writes made BY the sync engine (applying remote data, caching a Drive download, storing a Drive id) must not be
 * marked as local edits. The marker lives on the Dexie transaction, so unrelated writes running at the same time in
 * the same context are still tracked.
 */
import Dexie, { type Table } from 'dexie';
import { db } from '@/services/storage/db';

const MARK = '__socialpilotSync';

export async function quietly<T>(tables: Table[], fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', tables, async () => {
    (Dexie.currentTransaction as unknown as Record<string, boolean>)[MARK] = true;
    return fn();
  });
}

/** True inside a quietly() transaction (or one of its sub-transactions). */
export function isQuiet(trans: unknown): boolean {
  for (let t = trans as (Record<string, unknown> & { parent?: unknown }) | undefined; t; t = t.parent as typeof t) if (t[MARK]) return true;
  return false;
}
