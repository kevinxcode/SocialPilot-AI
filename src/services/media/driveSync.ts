/** Imports images and videos from a public Google Drive link. No Google sign-in: requests carry no cookies. */
import { importFiles } from './importer';

export const DRIVE_ORIGINS = ['https://drive.google.com/*', 'https://drive.usercontent.google.com/*', 'https://*.googleusercontent.com/*'];
export const DRIVE_LINK_KEY = 'driveFolderUrl';
const SYNCED_KEY = 'driveSyncedIds';
const MAX_DEPTH = 5;
const MAX_FILES = 500;
const MAX_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''];

export type DriveLink = { kind: 'folder' | 'file'; id: string };

export function parseDriveLink(link: string): DriveLink | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com') return null;
  const folder = u.pathname.match(/\/folders\/([\w-]+)/);
  if (folder) return { kind: 'folder', id: folder[1] };
  const file = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/);
  if (file) return { kind: 'file', id: file[1] };
  const id = u.searchParams.get('id');
  return id && /^[\w-]+$/.test(id) ? { kind: 'file', id } : null;
}

export interface DriveEntry {
  id: string;
  name: string;
  isFolder: boolean;
}

/** Google's public folder view; treated as untrusted text and never rendered. */
export function parseFolderHtml(html: string): { title: string; entries: DriveEntry[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const entries: DriveEntry[] = [];
  for (const el of Array.from(doc.querySelectorAll('.flip-entry'))) {
    const id = el.id.replace(/^entry-/, '');
    const name = el.querySelector('.flip-entry-title')?.textContent?.trim();
    if (!/^[\w-]+$/.test(id) || !name) continue;
    entries.push({ id, name, isFolder: /\/folders\//.test(el.querySelector('a')?.getAttribute('href') ?? '') });
  }
  return { title: (doc.title || 'Google Drive').replace(/\s*-\s*Google Drive\s*$/i, '').trim(), entries };
}

export interface DriveSyncResult {
  added: number;
  skipped: number;
  duplicates: number;
  failed: string[];
}

type Remote = { id: string; name: string; path: string; single?: boolean };

async function listFolder(id: string, prefix: string, doFetch: typeof fetch, seen: Set<string>, depth: number, out: Remote[], res: DriveSyncResult) {
  if (seen.has(id) || depth > MAX_DEPTH) return;
  seen.add(id);
  const r = await doFetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`, { credentials: 'omit' });
  if (!r.ok) {
    if (depth === 0) throw new Error('Could not open this folder. In Google Drive, set sharing to “Anyone with the link”.');
    res.failed.push(`${prefix || id}: subfolder is not public`);
    return;
  }
  const { title, entries } = parseFolderHtml(await r.text());
  const here = depth === 0 ? title : prefix;
  for (const e of entries) {
    if (e.isFolder) await listFolder(e.id, `${here}/${e.name}`, doFetch, seen, depth + 1, out, res);
    else if (mimeOf(e.name)) out.push({ id: e.id, name: e.name, path: `${here}/${e.name}` });
    else res.skipped++;
  }
}

/** The file name Drive sends with a download; never contains a folder path. */
function headerFileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = disposition.match(/filename="([^"]+)"/i)?.[1];
  if (encoded) {
    try {
      name = decodeURIComponent(encoded);
    } catch {
      /* keep the plain name */
    }
  }
  return name?.split(/[/\\]/).pop()?.trim() || undefined;
}

/** A single-file link has no listing, so the name and type come from the download itself. */
function singleFileName(item: Remote, r: Response): string {
  const named = headerFileName(r.headers.get('content-disposition'));
  if (named) return named;
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = Object.entries(MIME).find(([, mime]) => mime === type)?.[0];
  if (!ext) throw new Error('not an image or video');
  return `${item.name}.${ext}`;
}

async function download(item: Remote, doFetch: typeof fetch): Promise<File> {
  const r = await doFetch(`https://drive.usercontent.google.com/download?id=${item.id}&export=download&confirm=t`, { credentials: 'omit' });
  // Drive answers with an HTML page when a file is private or over its download quota.
  if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('not public or download limit reached');
  const name = item.single ? singleFileName(item, r) : item.name;
  const type = mimeOf(name);
  if (!type) throw new Error('not an image or video');
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('larger than 200 MB');
  const blob = await r.blob();
  if (blob.size > MAX_BYTES) throw new Error('larger than 200 MB');
  const file = new File([blob], name, { type });
  Object.defineProperty(file, 'webkitRelativePath', { value: item.single ? `Google Drive/${name}` : item.path });
  return file;
}

/** After the library is cleared, the next sync may bring every Drive file back. */
export async function forgetDriveSync(): Promise<void> {
  await chrome.storage.local.remove(SYNCED_KEY);
}

export async function syncDriveLink(link: string, opts: { fetch?: typeof fetch; onProgress?: (done: number, total: number) => void } = {}): Promise<DriveSyncResult> {
  const parsed = parseDriveLink(link);
  if (!parsed) throw new Error('Paste a Google Drive folder or file link');
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const res: DriveSyncResult = { added: 0, skipped: 0, duplicates: 0, failed: [] };
  const remote: Remote[] = [];
  if (parsed.kind === 'folder') await listFolder(parsed.id, '', doFetch, new Set(), 0, remote, res);
  else remote.push({ id: parsed.id, name: `drive-${parsed.id}`, path: 'Google Drive', single: true });

  // Files already synced are not downloaded again, and media deleted from the library does not come back.
  const synced = new Set(((await chrome.storage.local.get(SYNCED_KEY))[SYNCED_KEY] as string[] | undefined) ?? []);
  const todo = remote.filter((f) => !synced.has(f.id));
  if (todo.length > MAX_FILES) res.failed.push(`Only the first ${MAX_FILES} of ${todo.length} new files were synced. Sync again for the rest.`);
  const batch = todo.slice(0, MAX_FILES);
  for (const [i, item] of batch.entries()) {
    try {
      const r = await importFiles([await download(item, doFetch)]);
      res.added += r.added;
      res.duplicates += r.duplicates;
      res.skipped += r.skipped;
      synced.add(item.id);
      await chrome.storage.local.set({ [SYNCED_KEY]: [...synced] });
    } catch (e) {
      res.failed.push(`${item.name}: ${(e as Error).message}`);
    }
    opts.onProgress?.(i + 1, batch.length);
  }
  return res;
}
