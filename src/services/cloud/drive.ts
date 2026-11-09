/**
 * Media Library files in the user's own Google Drive, folder "SocialPilot Media".
 * Scope drive.file: the extension only sees files it created itself — never the rest of the Drive.
 * Local copies are kept in IndexedDB as a cache; a device without the file downloads it when it is needed.
 */
import { db } from '@/services/storage/db';
import type { MediaItem } from '@/types/models';
import { driveToken } from './auth';

type Fetch = typeof fetch;
const FOLDER_KEY = 'driveFolderId';
const FOLDER_NAME = 'SocialPilot Media';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {
  name = 'DriveError';
}

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new DriveError(`Google Drive ${r.status}: ${(j as { error?: { message?: string } }).error?.message ?? 'request failed'}`);
  return j;
}

/** Finds or creates the app folder (cached per device). */
export async function folderId(f: Fetch = fetch): Promise<string> {
  const cached = (await chrome.storage.local.get(FOLDER_KEY))[FOLDER_KEY] as string | undefined;
  if (cached) return cached;
  const auth = { Authorization: `Bearer ${await driveToken()}` };
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await json<{ files?: { id: string }[] }>(await f(`${API}/files?q=${q}&fields=files(id)&spaces=drive`, { headers: auth }));
  const id =
    found.files?.[0]?.id ??
    (
      await json<{ id: string }>(
        await f(`${API}/files?fields=id`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
        }),
      )
    ).id;
  await chrome.storage.local.set({ [FOLDER_KEY]: id });
  return id;
}

/** Uploads one media file; returns its Drive file id. */
export async function uploadMedia(m: Pick<MediaItem, 'name' | 'type' | 'blob'>, f: Fetch = fetch): Promise<string> {
  if (!m.blob) throw new DriveError(`No local file for ${m.name}`);
  const parent = await folderId(f);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: m.name, mimeType: m.type, parents: [parent] })], { type: 'application/json' }));
  form.append('file', m.blob, m.name);
  const r = await f(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { Authorization: `Bearer ${await driveToken()}` }, body: form });
  return (await json<{ id: string }>(r)).id;
}

export async function downloadMedia(fileId: string, f: Fetch = fetch): Promise<Blob> {
  const r = await f(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${await driveToken()}` } });
  if (!r.ok) throw new DriveError(`Google Drive ${r.status}: could not download the media file`);
  return r.blob();
}

/** Moves the file to the Drive trash (recoverable for 30 days). */
export async function trashMedia(fileId: string, f: Fetch = fetch): Promise<void> {
  const r = await f(`${API}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await driveToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok && r.status !== 404) throw new DriveError(`Google Drive ${r.status}: could not delete the media file`);
}

/** Local file of a media item, downloading (and caching) it from Drive when this device does not have it yet. */
export async function mediaBlob(m: MediaItem, f: Fetch = fetch): Promise<Blob | null> {
  if (m.blob) return m.blob;
  if (!m.driveFileId) return null;
  const blob = await downloadMedia(m.driveFileId, f);
  await db.media.update(m.id, { blob }); // local cache (the blob itself is never sent to Firestore)
  return blob;
}
