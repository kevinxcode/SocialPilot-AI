import { z } from 'zod';
import { db, TABLES } from './db';

const row = z.object({ id: z.string() }).passthrough();
const modelRow = z.object({ key: z.string() }).passthrough();

const schema = z.object({
  version: z.literal(1),
  exportedAt: z.number().optional(),
  brands: z.array(row).default([]),
  knowledge: z.array(row).default([]),
  providers: z.array(row).default([]),
  models: z.array(modelRow).default([]),
  accounts: z.array(row).default([]),
  ideas: z.array(row).default([]),
  posts: z.array(row).default([]),
  queue: z.array(row).default([]),
  aiUsage: z.array(row).default([]),
  logs: z.array(row).default([]),
});

const EXPORTED = TABLES.filter((t) => t !== 'media');

/** Exports all data except media blobs (too large) and settings/API keys (never exported). */
export async function exportAll(): Promise<Blob> {
  const out: Record<string, unknown> = { version: 1, exportedAt: Date.now() };
  for (const t of EXPORTED) out[t] = await db.table(t).toArray();
  return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
}

async function blobText(b: Blob): Promise<string> {
  if (typeof b.text === 'function') return b.text();
  return new Response(b).text();
}

/** Validates the whole file first; writes in one transaction or not at all. */
export async function importAll(file: Blob): Promise<void> {
  const parsed = schema.parse(JSON.parse(await blobText(file)));
  await db.transaction('rw', EXPORTED.map((t) => db.table(t)), async () => {
    for (const t of EXPORTED) {
      const rows = (parsed as unknown as Record<string, unknown[]>)[t];
      if (rows.length) await db.table(t).bulkPut(rows);
    }
  });
}
