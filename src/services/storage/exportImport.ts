import { z } from 'zod';
import { db, TABLES } from './db';
import { getSettings } from './settings';
import type { MediaItem, Settings } from '@/types/models';

const row = z.object({ id: z.string() }).passthrough();
const modelRow = z.object({ key: z.string() }).passthrough();
const mediaRow = z.object({ id: z.string(), name: z.string(), type: z.string(), data: z.string().optional() }).passthrough();

const schema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
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
  groups: z.array(row).default([]),
  topics: z.array(row).default([]),
  /** v2: media library with the files as data URLs */
  media: z.array(mediaRow).default([]),
  /** v2: settings (AI API keys only when the user chose to include them) */
  settings: z.record(z.unknown()).optional(),
});

const DATA_TABLES = TABLES.filter((t) => t !== 'media');

async function toDataUrl(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await new Response(b).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // chunked: large files
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function fromDataUrl(url: string): Promise<Blob> {
  const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) throw new Error('Invalid media data in backup');
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

function withoutKeys(s: Settings): Settings {
  const providers = Object.fromEntries(Object.entries(s.providers).map(([id, p]) => [id, { ...p, apiKey: undefined }])) as Settings['providers'];
  return { ...s, providers };
}

/**
 * Full backup: all data, the media library (files included) and the settings.
 * AI API keys are left out unless `includeApiKeys` is true (the file is then as sensitive as the keys themselves).
 */
export async function exportAll(opts: { includeApiKeys?: boolean } = {}): Promise<Blob> {
  const out: Record<string, unknown> = { version: 2, exportedAt: Date.now() };
  for (const t of DATA_TABLES) out[t] = await db.table(t).toArray();
  const media: unknown[] = [];
  for (const m of (await db.media.toArray()) as MediaItem[]) {
    const { blob, ...meta } = m;
    media.push({ ...meta, data: blob ? await toDataUrl(blob) : undefined });
  }
  out.media = media;
  const s = await getSettings();
  out.settings = opts.includeApiKeys ? s : withoutKeys(s);
  return new Blob([JSON.stringify(out)], { type: 'application/json' });
}

async function blobText(b: Blob): Promise<string> {
  if (typeof b.text === 'function') return b.text();
  return new Response(b).text();
}

/**
 * Validates the whole file first; writes the data in one transaction or not at all.
 * Settings from the backup are applied, but AI API keys already on this device are kept when the backup has none.
 */
export async function importAll(file: Blob): Promise<{ posts: number; media: number; settings: boolean }> {
  const parsed = schema.parse(JSON.parse(await blobText(file)));
  const media: MediaItem[] = [];
  for (const m of parsed.media) {
    const { data, ...meta } = m as { data?: string } & Record<string, unknown>;
    if (!data) continue; // an item without its file cannot be used
    media.push({ ...(meta as unknown as MediaItem), blob: await fromDataUrl(data) });
  }
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of DATA_TABLES) {
      const rows = (parsed as unknown as Record<string, unknown[]>)[t];
      if (rows.length) await db.table(t).bulkPut(rows);
    }
    if (media.length) await db.media.bulkPut(media);
  });
  if (parsed.settings) {
    const local = await getSettings();
    const incoming = parsed.settings as unknown as Settings;
    const providers = Object.fromEntries(
      Object.entries({ ...local.providers, ...incoming.providers }).map(([id, p]) => [
        id,
        { ...p, apiKey: (p as { apiKey?: string }).apiKey || local.providers[id as keyof Settings['providers']]?.apiKey },
      ]),
    ) as Settings['providers'];
    await chrome.storage.local.set({ settings: { ...local, ...incoming, providers } });
  }
  return { posts: parsed.posts.length, media: media.length, settings: !!parsed.settings };
}
