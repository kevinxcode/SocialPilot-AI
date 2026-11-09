import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { typeText, readEditorText } from '@/services/publishing/rpa/dom';
import { runPreflight, runPublish, runFindExisting } from '@/services/publishing/rpa/engine';
import { THREADS } from '@/services/publishing/rpa/selectors/threads';
import { FACEBOOK } from '@/services/publishing/rpa/selectors/facebook';
import { fingerprint } from '@/services/publishing/fingerprint';

// jsdom lacks DataTransfer; minimal stand-in sufficient for file attachment.
if (typeof globalThis.DataTransfer === 'undefined') {
  class DT {
    private list: File[] = [];
    items = { add: (f: File) => this.list.push(f) };
    get files() {
      const l = [...this.list] as unknown as FileList & File[];
      (l as unknown as { item: (i: number) => File }).item = (i: number) => l[i];
      return l;
    }
    setData() {}
    getData() { return ''; }
  }
  (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = DT;
}

const fx = (p: string) => readFileSync(join(__dirname, '../fixtures', p), 'utf8');
const FAST = { timeoutMs: 600, pollMs: 20, delay: false };

function load(html: string, url = 'https://www.threads.com/@cuciqu.pro') {
  document.body.innerHTML = html;
  history.replaceState(null, '', new URL(url).pathname);
}

/** When the composer opener is clicked, inject the composer fixture; Post click closes it. */
const cleanups: (() => void)[] = [];
function wireComposer(composerHtml: string, onPost = vi.fn()) {
  const handler = (e: Event) => {
      const el = (e.target as HTMLElement).closest('[role="button"]');
      if (!el) return;
      const txt = (el.textContent ?? '') + (el.getAttribute('aria-label') ?? '') + (el.querySelector('svg')?.getAttribute('aria-label') ?? '');
      if (/^(Create|Buat)$|What's on your mind/.test(txt.trim()) && !document.querySelector('[role="dialog"]')) {
        document.body.insertAdjacentHTML('beforeend', composerHtml);
        const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type=file]')!;
        input.addEventListener('change', () => {
          for (const f of Array.from(input.files ?? [])) document.querySelector('.previews')!.insertAdjacentHTML('beforeend', `<img alt="${f.name}" src="blob:x">`);
        });
      }
      if (/^(Posting|Post)$/.test(txt.trim()) || el.getAttribute('aria-label') === 'Post') {
        onPost(readEditorText(document.querySelector('[role="dialog"] [contenteditable]')!));
        document.querySelector('[role="dialog"]')?.remove();
      }
  };
  document.addEventListener('click', handler, { capture: true });
  cleanups.push(() => document.removeEventListener('click', handler, { capture: true }));
  return onPost;
}

afterEach(() => {
  document.body.innerHTML = '';
  while (cleanups.length) cleanups.pop()!();
});

test('typeText preserves emoji, Indonesian text and newlines', async () => {
  document.body.innerHTML = '<div contenteditable="true" role="textbox"></div>';
  const el = document.querySelector<HTMLElement>('[contenteditable]')!;
  const text = 'Halo pemilik laundry 👋🧺\n\nCucian tertukar? Ini solusinya — mudah & cepat!\n#laundry';
  await typeText(el, text);
  expect(readEditorText(el)).toBe(text);
});

test('Threads preflight fails when logged out', async () => {
  load(fx('threads/logged-out.html'));
  const r = await runPreflight(THREADS, { profileUrl: 'https://www.threads.com/@cuciqu.pro' }, FAST);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/not logged in/i);
});

test('Threads preflight passes on own profile', async () => {
  load(fx('threads/profile-own.html'));
  expect(await runPreflight(THREADS, { profileUrl: 'https://www.threads.com/@cuciqu.pro' }, FAST)).toEqual({ ok: true });
});

test('Threads preflight fails on another account profile', async () => {
  load(fx('threads/profile-own.html').replace('Edit profile', 'Follow'), 'https://www.threads.com/@someone');
  const r = await runPreflight(THREADS, { profileUrl: 'https://www.threads.com/@cuciqu.pro' }, FAST);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/@cuciqu\.pro/);
});

test('Facebook preflight fails when logged out', async () => {
  load(fx('facebook/logged-out.html'), 'https://www.facebook.com/login');
  const r = await runPreflight(FACEBOOK, { profileUrl: 'https://www.facebook.com/cuciqupro', pageName: 'CuciQu Pro' }, FAST);
  expect(r).toMatchObject({ ok: false });
  expect(r.reason).toMatch(/not logged in/i);
});

test('Facebook preflight fails when acting as personal profile', async () => {
  load(fx('facebook/page-as-personal.html'), 'https://www.facebook.com/cuciqupro');
  const r = await runPreflight(FACEBOOK, { profileUrl: 'https://www.facebook.com/cuciqupro', pageName: 'CuciQu Pro' }, FAST);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/not posting as the Page/i);
});

test('Facebook publish refuses (never clicks Post) when composer author is not the Page', async () => {
  load(fx('facebook/page-admin.html'), 'https://www.facebook.com/cuciqupro');
  const onPost = wireComposer(fx('facebook/composer.html').replace('AUTHOR', 'Budi Santoso'));
  const r = await runPublish(FACEBOOK, { text: 'Halo', files: [], dryRun: false, pageName: 'CuciQu Pro' }, FAST);
  expect(r.status).toBe('failed');
  expect('reason' in r && r.reason).toMatch(/CuciQu Pro/);
  expect(onPost).not.toHaveBeenCalled();
});

test('Threads publish types text, attaches image and clicks Post', async () => {
  load(fx('threads/profile-own.html'));
  const onPost = wireComposer(fx('threads/composer.html'));
  const text = 'Tes 🧺\nbaris dua';
  const r = await runPublish(THREADS, { text, files: [{ name: 'a.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], dryRun: false }, FAST);
  expect(r).toEqual({ status: 'clicked' });
  expect(onPost).toHaveBeenCalledWith(text);
});

test('dry run fills composer and does not click Post', async () => {
  load(fx('threads/profile-own.html'));
  const onPost = wireComposer(fx('threads/composer.html'));
  const r = await runPublish(THREADS, { text: 'Dry run', files: [], dryRun: true }, FAST);
  expect(r.status).toBe('dry-run');
  expect(onPost).not.toHaveBeenCalled();
  expect(readEditorText(document.querySelector('[role="dialog"] [contenteditable]')!)).toBe('Dry run');
});

test('findExisting matches caption fingerprint and returns permalink', async () => {
  load(fx('threads/profile-own.html'));
  const fp = fingerprint('Cucian pelanggan tertukar lagi? 😩\nDengan CuciQu Pro setiap pesanan tercatat rapi.');
  expect(await runFindExisting(THREADS, fp, FAST)).toEqual({ found: true, url: new URL('/@cuciqu.pro/post/DAbc123XYZ', location.origin).href });
  expect((await runFindExisting(THREADS, fingerprint('tidak ada postingan seperti ini'), FAST)).found).toBe(false);
});

test('findExisting on Facebook page feed', async () => {
  load(fx('facebook/page-admin.html'), 'https://www.facebook.com/cuciqupro');
  const r = await runFindExisting(FACEBOOK, fingerprint('Tips hari ini: pisahkan cucian per pelanggan 🧺 Coba CuciQu Pro!'), FAST);
  expect(r).toEqual({ found: true, url: 'https://www.facebook.com/cuciqupro/posts/pfbid02abcDEF' });
});

test('composer already open (Threads intent URL) → no opener needed, text typed and posted', async () => {
  load(fx('threads/composer.html'), 'https://www.threads.com/intent/post');
  const onPost = vi.fn();
  const handler = (e: Event) => {
    const el = (e.target as HTMLElement).closest('[role="button"]');
    if (el && /^(Posting|Post)$/.test((el.textContent ?? '').trim())) {
      onPost();
      document.querySelector('[role="dialog"]')?.remove();
    }
  };
  document.addEventListener('click', handler, { capture: true });
  cleanups.push(() => document.removeEventListener('click', handler, { capture: true }));
  const r = await runPublish(THREADS, { text: 'via intent', files: [], dryRun: false }, FAST);
  expect(r).toEqual({ status: 'clicked' });
  expect(onPost).toHaveBeenCalledTimes(1);
});

test('editor check tolerates Lexical paragraph/blank-line rendering but rejects missing or duplicated text', async () => {
  const { editorMatches } = await import('@/services/publishing/rpa/dom');
  const text = 'Catatan kertas bikin pusing? 🧺\n\nCuciQu Pro hadir.\n\n#CuciQuPro #TipsLaundry';
  document.body.innerHTML =
    '<div contenteditable="true" role="textbox"><p dir="auto"><span>Catatan kertas bikin pusing? 🧺</span></p><p><br></p><p><br></p><p><span>CuciQu Pro hadir.</span></p><p><br></p><p><a href="/search?q=CuciQuPro">#CuciQuPro</a> <a>#TipsLaundry</a></p></div>';
  const el = document.querySelector('[contenteditable]')!;
  expect(editorMatches(el, text)).toBe(true);
  el.insertAdjacentHTML('beforeend', '<p>Catatan kertas bikin pusing? 🧺</p>');
  expect(editorMatches(el, text)).toBe(false);
  el.innerHTML = '<p>Catatan kertas bikin pusing? 🧺</p>';
  expect(editorMatches(el, text)).toBe(false);
});
