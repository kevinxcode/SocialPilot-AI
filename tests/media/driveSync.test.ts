// @vitest-environment jsdom
import { parseDriveLink, parseFolderHtml, syncDriveLink } from '@/services/media/driveSync';
import { db, resetDb } from '@/services/storage/db';

const entry = (id: string, name: string, folder = false) =>
  `<div class="flip-entry" id="entry-${id}"><a href="https://drive.google.com/${folder ? 'drive/folders' : 'file/d'}/${id}${folder ? '' : '/view'}?usp=drive_web"><div class="flip-entry-title">${name}</div></a></div>`;
const page = (title: string, ...entries: string[]) => `<html><head><title>${title}</title></head><body>${entries.join('')}</body></html>`;

function fakeFetch(pages: Record<string, string>, files: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.includes('embeddedfolderview')) {
      const html = pages[u.searchParams.get('id')!];
      return html ? new Response(html, { headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 });
    }
    const body = files[u.searchParams.get('id')!];
    return body === undefined ? new Response('<html>denied</html>', { headers: { 'content-type': 'text/html' } }) : new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

test('reads folder and file links, and refuses other sites', () => {
  expect(parseDriveLink('https://drive.google.com/drive/folders/abc_123-x?usp=sharing')).toEqual({ kind: 'folder', id: 'abc_123-x' });
  expect(parseDriveLink('https://drive.google.com/drive/u/0/folders/abc123')).toEqual({ kind: 'folder', id: 'abc123' });
  expect(parseDriveLink('https://drive.google.com/file/d/file123/view')).toEqual({ kind: 'file', id: 'file123' });
  expect(parseDriveLink('https://drive.google.com/open?id=open123')).toEqual({ kind: 'file', id: 'open123' });
  expect(parseDriveLink('https://evil.example/drive/folders/abc')).toBeNull();
});

test('parses files and subfolders from a public folder page', () => {
  const r = parseFolderHtml(page('Marketing - Google Drive', entry('f1', 'a &amp; b.png'), entry('d1', 'story', true)));
  expect(r.title).toBe('Marketing');
  expect(r.entries).toEqual([{ id: 'f1', name: 'a & b.png', isFolder: false }, { id: 'd1', name: 'story', isFolder: true }]);
});

test('syncs media from subfolders and skips non-media', async () => {
  const f = fakeFetch(
    { root: page('Marketing', entry('f1', 'satu.png'), entry('x', 'notes.pdf'), entry('d1', 'story', true)), d1: page('story', entry('f2', 'dua.jpg'), entry('root', 'loop', true)) },
    { f1: 'png-data', f2: 'jpg-data' },
  );
  const r = await syncDriveLink('https://drive.google.com/drive/folders/root', { fetch: f });
  expect(r).toMatchObject({ added: 2, skipped: 1, failed: [] });
  const media = await db.media.toArray();
  expect(media.map((m) => m.type).sort()).toEqual(['image/jpeg', 'image/png']);
  expect(media.find((m) => m.name === 'dua.jpg')?.category).toBe('story');
});

test('a second sync downloads only new files', async () => {
  const pages = { root: page('Marketing', entry('f1', 'satu.png')) };
  await syncDriveLink('https://drive.google.com/drive/folders/root', { fetch: fakeFetch(pages, { f1: 'data' }) });
  const again = fakeFetch({ root: page('Marketing', entry('f1', 'satu.png'), entry('f2', 'baru.png')) }, { f1: 'data', f2: 'new' });
  const r = await syncDriveLink('https://drive.google.com/drive/folders/root', { fetch: again });
  expect(r.added).toBe(1);
  expect((again as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes('id=f1') && String(u).includes('download'))).toHaveLength(0);
});

test('a file that is not public is reported and retried next time', async () => {
  const pages = { root: page('Marketing', entry('f1', 'rahasia.png')) };
  const r = await syncDriveLink('https://drive.google.com/drive/folders/root', { fetch: fakeFetch(pages, {}) });
  expect(r.added).toBe(0);
  expect(r.failed[0]).toMatch(/rahasia\.png/);
  const next = await syncDriveLink('https://drive.google.com/drive/folders/root', { fetch: fakeFetch(pages, { f1: 'ok' }) });
  expect(next.added).toBe(1);
});

test('a private folder gives a clear error', async () => {
  await expect(syncDriveLink('https://drive.google.com/drive/folders/none', { fetch: fakeFetch({}, {}) })).rejects.toThrow(/Anyone with the link/);
});
