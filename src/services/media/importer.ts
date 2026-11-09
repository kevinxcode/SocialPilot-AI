import { db } from '@/services/storage/db';
import { uid } from '@/lib/utils';
import type { MediaItem } from '@/types/models';

const STOP = new Set(['img', 'image', 'images', 'photo', 'foto', 'final', 'copy', 'new', 'jpg', 'png', 'jpeg', 'webp', 'mp4']);

export function tagsFromPath(path: string): string[] {
  const parts = path.replace(/\.[a-z0-9]+$/i, '').split(/[/\\]/);
  const words = parts.flatMap((p) => p.toLowerCase().split(/[^a-z0-9À-ɏ]+/i));
  return [...new Set(words.filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

async function dimensions(file: Blob): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return {};
  try {
    const bmp = await createImageBitmap(file);
    const d = { width: bmp.width, height: bmp.height };
    bmp.close();
    return d;
  } catch {
    return {};
  }
}

async function thumbnail(file: Blob): Promise<string | undefined> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.7 });
    return await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

type Entry = { file: File; path: string };

/** Folders never worth scanning for marketing media (dependency/build/VCS/hidden). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'venv', '.venv', '__pycache__', 'site-packages', 'vendor', 'target']);
export const shouldSkipDir = (name: string) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());

async function* walk(dir: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<Entry> {
  // @ts-expect-error values() exists on FileSystemDirectoryHandle in Chromium
  for await (const h of dir.values() as AsyncIterable<FileSystemHandle>) {
    if (h.kind === 'file') yield { file: await (h as FileSystemFileHandle).getFile(), path: `${prefix}/${h.name}` };
    else if (!shouldSkipDir(h.name)) yield* walk(h as FileSystemDirectoryHandle, `${prefix}/${h.name}`);
  }
}

export interface ImportResult {
  added: number;
  skipped: number;
  duplicates: number;
}

/** Imports images/videos from picked files or a directory handle. Dedupe by name + size. */
export async function importFiles(
  input: File[] | FileSystemDirectoryHandle,
  onProgress?: (done: number) => void,
): Promise<ImportResult> {
  const entries: AsyncIterable<Entry> | Entry[] = Array.isArray(input)
    ? input.map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
    : walk(input, input.name);
  const existing = new Set((await db.media.toArray()).map((m) => `${m.name}|${m.size}`));
  const r: ImportResult = { added: 0, skipped: 0, duplicates: 0 };
  for await (const { file, path } of entries) {
    if (!/^(image|video)\//.test(file.type)) {
      r.skipped++;
      continue;
    }
    const key = `${file.name}|${file.size}`;
    if (existing.has(key)) {
      r.duplicates++;
      continue;
    }
    existing.add(key);
    const folder = path.split(/[/\\]/).slice(-2, -1)[0];
    const item: MediaItem = {
      id: uid(),
      name: file.name,
      type: file.type,
      size: file.size,
      blob: file,
      tags: tagsFromPath(path),
      category: folder || undefined,
      usedCount: 0,
      createdAt: Date.now(),
      ...(await dimensions(file)),
      thumb: await thumbnail(file),
    };
    await db.media.add(item);
    r.added++;
    onProgress?.(r.added);
  }
  return r;
}
