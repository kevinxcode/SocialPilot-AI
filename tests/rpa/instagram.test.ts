import { captionBox, captionCounter, counterMatches, createPostInput, describeScreen, instagramHandle, runInstagramFindPost, runInstagramPreflight, runInstagramPublish, runInstagramRecent } from '@/services/publishing/rpa/instagram';
import { INSTAGRAM } from '@/services/publishing/rpa/selectors/instagram';
import { fingerprint } from '@/services/publishing/fingerprint';

// jsdom lacks DataTransfer; minimal stand-in sufficient for file attachment.
if (typeof globalThis.DataTransfer === 'undefined') {
  class DT {
    private list: File[] = [];
    private data: Record<string, string> = {};
    items = { add: (f: File) => this.list.push(f) };
    get files() {
      return [...this.list] as unknown as FileList;
    }
    setData(type: string, v: string) {
      this.data[type] = v;
    }
    getData(type: string) {
      return this.data[type] ?? '';
    }
  }
  (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = DT;
}
// jsdom: a paste event that carries clipboardData, like a browser's.
class PasteEvent extends Event {
  clipboardData: DataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: DataTransfer }) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}
(globalThis as unknown as { ClipboardEvent: unknown }).ClipboardEvent = PasteEvent;

vi.setConfig({ testTimeout: 20_000 }); // simple fake editors make typeText wait for its paste check
const FAST = { timeoutMs: 600, pollMs: 20, delay: false };
const PNG = { name: 'a.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const MP4 = { name: 'a.mp4', type: 'video/mp4', dataUrl: 'data:video/mp4;base64,AAAA' };
const CAPTION = 'Laundry rapi tanpa ribet bersama CuciQu Pro setiap hari #laundry';

function at(path: string, html: string) {
  history.replaceState(null, '', path);
  document.body.innerHTML = html;
}

const PROFILE = `
  <main>
    <a role="link" href="#"><svg aria-label="New post"></svg></a>
    <a href="/accounts/edit/">Edit profile</a>
  </main>`;

/**
 * A fake Instagram: Create → menu "Post" → dialog with file input → Next (crop) → Next (edit) → caption → Share.
 * `share` decides what Instagram shows after Share.
 */
/** accepts: which input method Instagram's editor really takes in (like Lexical: anything else only changes the screen). */
type Accepts = 'paste' | 'insertText' | 'chars' | 'spaceOnly' | 'none';
function fakeInstagram(opts: { menu?: boolean; share?: 'shared' | 'error' | 'nothing'; reelsNotice?: boolean; realCaptionStep?: boolean; slowSteps?: boolean; ignorePaste?: boolean; accepts?: Accepts } = {}) {
  const accepts: Accepts = opts.accepts ?? (opts.ignorePaste ? 'none' : 'paste');
  /** Lexical-like editor: only what arrives through a paste counts (writing into the DOM does not), like on instagram.com. */
  let model = '';
  at('/cuciqu.pro/', PROFILE);
  let transitioning = false;
  let nextClicks = 0;
  let ignoredClicks = 0;
  const shared = vi.fn();
  const step = (name: 'select' | 'crop' | 'edit' | 'caption') => {
    document.querySelector('[role="dialog"]')?.remove();
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Create new post');
    d.innerHTML =
      name === 'select'
        ? '<button>Select from computer</button><input type="file" accept="image/jpeg,image/png,video/mp4">'
        : name === 'caption'
          ? // As seen on instagram.com (2026-11-10): Lexical caption editor + Instagram's character counter
            '<div role="button">Back</div><h1>Create new post</h1><div role="button">Share</div>' +
            '<div><div aria-label="Add a caption..." contenteditable="true" role="textbox" data-lexical-editor="true" spellcheck="true" tabindex="0"><p><br></p></div>' +
            '<div aria-hidden="true">Add a caption...</div></div><div role="button">Emoji</div><div role="button">0/2,200</div>' +
            '<div role="button">Tag people</div><div role="button">Share toUp chevron icon</div>'
          : `<img src="blob:x"><div role="button">Next</div><span>${name}</span>`;
    document.body.appendChild(d);
    if (name === 'caption') {
      const ed = d.querySelector('[contenteditable="true"]') as HTMLElement;
      const counter = Array.from(d.querySelectorAll('[role="button"]')).find((b) => /\/2,200$/.test(b.textContent ?? ''))!;
      const render = () => {
        counter.textContent = `${model.length}/2,200`;
      };
      ed.addEventListener('paste', (e) => {
        e.preventDefault();
        if (accepts !== 'paste') return;
        model += (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        ed.innerHTML = model.split('\n').map((l) => `<p>${l || '<br>'}</p>`).join('');
        render();
      });
      // document.execCommand as the editor sees it: the screen always changes, the editor state only for accepted input.
      (document as unknown as { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
        if (cmd === 'delete') {
          model = '';
          ed.innerHTML = '<p><br></p>';
        } else if (cmd === 'insertText' && value != null) {
          ed.append(value);
          const ok = accepts === 'insertText' || (accepts === 'chars' && [...value].length === 1) || (accepts === 'spaceOnly' && value === ' ');
          if (ok) model += value;
        } else if (cmd === 'insertParagraph' || cmd === 'insertLineBreak') {
          ed.append(document.createElement('br'));
          if (accepts === 'insertText' || accepts === 'chars') model += '\n';
        } else return false;
        render();
        return true;
      };
    }
    if (name === 'select') {
      d.querySelector('input')!.addEventListener('change', () => {
        if (opts.reelsNotice) {
          const n = document.createElement('div');
          n.setAttribute('role', 'dialog');
          n.innerHTML = '<span>Video posts are now shared as reels</span><button>OK</button>';
          n.querySelector('button')!.addEventListener('click', () => n.remove());
          document.body.appendChild(n);
        }
        setTimeout(() => step('crop'), 10);
      });
    }
  };
  const onClick = (e: Event) => {
    const el = e.target as HTMLElement;
    const t = (el.textContent ?? '').trim();
    if (el.closest('a[role="link"]') && !document.querySelector('[role="dialog"]') && !document.querySelector('#menu')) {
      if (opts.menu) {
        const m = document.createElement('div');
        m.id = 'menu';
        m.innerHTML = '<a role="link" href="#"><span>Post</span></a><a role="link" href="#"><span>Live video</span></a>';
        document.body.appendChild(m);
      } else step('select');
      return;
    }
    if (t === 'Post' && el.closest('#menu')) {
      document.getElementById('menu')!.remove();
      step('select');
    } else if (t === 'Next') {
      const go = () => step(document.querySelector('[role="dialog"] span')?.textContent === 'crop' ? 'edit' : 'caption');
      if (!opts.slowSteps) go();
      else if (!transitioning) {
        // Like instagram.com: the next screen appears after an animation; clicks meanwhile are ignored.
        transitioning = true;
        nextClicks++;
        setTimeout(() => {
          transitioning = false;
          go();
        }, 200);
      } else ignoredClicks++;
    } else if (t === 'Share') {
      shared(model.trim());
      const done = document.createElement('div');
      done.setAttribute('role', 'dialog');
      if (opts.share !== 'nothing') done.innerHTML = opts.share === 'error' ? '<span>Your post couldn\'t be shared.</span>' : '<h2>Post shared</h2><span>Your post has been shared.</span>';
      document.querySelector('[role="dialog"]')?.remove();
      document.body.appendChild(done);
    }
  };
  document.addEventListener('click', onClick, true);
  return {
    shared,
    clicks: () => ({ nextClicks, ignoredClicks }),
    stop: () => {
      document.removeEventListener('click', onClick, true);
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    },
  };
}

let stop = () => {};
afterEach(() => stop());

describe('Instagram profile URL', () => {
  test('handle is read from the profile URL; other pages are refused', () => {
    expect(instagramHandle('https://www.instagram.com/CuciQu.Pro/')).toBe('cuciqu.pro');
    expect(instagramHandle('https://instagram.com/cuciqu.pro?hl=id')).toBe('cuciqu.pro');
    expect(instagramHandle('https://www.instagram.com/p/ABC123/')).toBeNull();
    expect(instagramHandle('https://www.threads.com/@cuciqu.pro')).toBeNull();
  });
});

describe('Instagram preflight', () => {
  test('own profile with "Edit profile" → ok', async () => {
    at('/cuciqu.pro/', PROFILE);
    expect(await runInstagramPreflight(INSTAGRAM, { profileUrl: 'https://www.instagram.com/cuciqu.pro/' }, FAST)).toEqual({ ok: true });
  });

  test('logged out, or logged in as another account → refused with a clear reason', async () => {
    at('/accounts/login/', '<form id="loginForm"><input name="username"></form>');
    expect((await runInstagramPreflight(INSTAGRAM, { profileUrl: 'https://www.instagram.com/cuciqu.pro/' }, FAST)).reason).toMatch(/not logged in/i);
    at('/cuciqu.pro/', '<main><div role="button">Follow</div></main>');
    expect((await runInstagramPreflight(INSTAGRAM, { profileUrl: 'https://www.instagram.com/cuciqu.pro/' }, FAST)).reason).toMatch(/not @cuciqu\.pro/);
  });
});

describe('Instagram publish', () => {
  test('Create → file → Next → Next → caption → Share → confirmed', async () => {
    const ig = fakeInstagram();
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'clicked' });
    expect(ig.shared).toHaveBeenCalledWith(CAPTION);
  });

  test('[real-world 2026-11-10] caption box without role="textbox" (as on instagram.com) is found and filled', async () => {
    const ig = fakeInstagram({ realCaptionStep: true });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'clicked' });
    expect(ig.shared).toHaveBeenCalledWith(CAPTION);
  });

  test('[real-world 2026-11-10 #2] screens change after an animation: Next is clicked ONCE per screen and the caption step is reached', async () => {
    const ig = fakeInstagram({ realCaptionStep: true, slowSteps: true });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: true }, { ...FAST, timeoutMs: 3000 });
    expect(r).toMatchObject({ status: 'dry-run' });
    expect(ig.clicks()).toEqual({ nextClicks: 2, ignoredClicks: 0 });
    expect(document.querySelector('[contenteditable="true"]')?.textContent?.trimEnd()).toBe(CAPTION); // + the space that closes hashtag suggestions
  });

  test('[real-world #2] the full flow with slow screens ends with ONE Share and the Instagram confirmation', async () => {
    const ig = fakeInstagram({ realCaptionStep: true, slowSteps: true, menu: true });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 3000 });
    expect(r).toMatchObject({ status: 'clicked' });
    expect(ig.shared).toHaveBeenCalledTimes(1);
    expect(ig.shared).toHaveBeenCalledWith(CAPTION);
    expect(ig.clicks().nextClicks).toBe(2);
  });

  test('[real-world 2026-11-10 #3] Instagram ignores the caption (counter stays 0/2,200) → NOT shared, failed before Share', async () => {
    const ig = fakeInstagram({ realCaptionStep: true, ignorePaste: true });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/caption was not accepted/i) });
    expect(ig.shared).not.toHaveBeenCalled();
  });

  test('[real-world #3] the caption really reaches Instagram (its counter) and is the one shared', async () => {
    const ig = fakeInstagram({ realCaptionStep: true });
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('clicked');
    expect(ig.shared).toHaveBeenCalledWith(CAPTION);
  });

  test('[real-world 2026-11-10 #4] only the trailing SPACE reached Instagram (posted an empty caption) → now NOT shared', async () => {
    const ig = fakeInstagram({ accepts: 'spaceOnly' });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/caption was not accepted.*paste=0.*insert=0.*lines=0.*keys=/) });
    expect(ig.shared).not.toHaveBeenCalled();
  });

  test.each([
    ['paste', 'paste'],
    ['insertText', 'insert'],
    ['chars', 'keys'],
  ] as const)('editor that only takes "%s" → the caption gets in that way, proven by the counter, and is shared', async (accepts, method) => {
    const ig = fakeInstagram({ accepts });
    stop = ig.stop;
    const r = await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'clicked', note: expect.stringContaining(`Caption: ${method}, counter`) });
    expect(ig.shared).toHaveBeenCalledWith(CAPTION);
  });

  test('multi-line caption typed key by key keeps its line breaks', async () => {
    const ig = fakeInstagram({ accepts: 'chars' });
    stop = ig.stop;
    const text = 'Baris satu tentang laundry rapi\n\nBaris dua #cuciqu';
    expect((await runInstagramPublish(INSTAGRAM, { text, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('clicked');
    expect(ig.shared).toHaveBeenCalledWith(text);
  });

  test('a "Create" menu (Post / Live) is handled', async () => {
    const ig = fakeInstagram({ menu: true });
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('clicked');
  });

  test('[review] the profile tab "Postingan" is never clicked as the Create menu item', async () => {
    const ig = fakeInstagram({ menu: true });
    stop = ig.stop;
    const tab = document.createElement('a');
    tab.setAttribute('role', 'link');
    tab.setAttribute('href', '#');
    tab.innerHTML = '<span>Post</span>';
    const tabClick = vi.fn();
    tab.addEventListener('click', tabClick);
    document.querySelector('main')!.prepend(tab);
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('clicked');
    expect(tabClick).not.toHaveBeenCalled();
  });

  test('video: the "shared as reels" notice is acknowledged', async () => {
    const ig = fakeInstagram({ reelsNotice: true });
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [MP4], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('clicked');
  });

  test('dry run fills everything but never clicks Share', async () => {
    const ig = fakeInstagram();
    stop = ig.stop;
    expect(await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: true }, { ...FAST, timeoutMs: 2000 })).toMatchObject({ status: 'dry-run' });
    expect(ig.shared).not.toHaveBeenCalled();
    expect(document.querySelector('[contenteditable="true"]')?.textContent?.trimEnd()).toBe(CAPTION); // + the space that closes hashtag suggestions
  });

  test('after Share: an error or no confirmation is "unknown" (checked before any retry), never "failed"', async () => {
    let ig = fakeInstagram({ share: 'error' });
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 2000 })).status).toBe('unknown');
    ig.stop();
    ig = fakeInstagram({ share: 'nothing' });
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, { ...FAST, timeoutMs: 800 })).status).toBe('unknown');
  });

  test('no media, or more than one file → failed before touching Instagram', async () => {
    const ig = fakeInstagram();
    stop = ig.stop;
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [], dryRun: false }, FAST)).status).toBe('failed');
    expect((await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG, PNG], dryRun: false }, FAST)).status).toBe('failed');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('no Create button → failed with a clear reason', async () => {
    at('/cuciqu.pro/', '<main></main>');
    expect(await runInstagramPublish(INSTAGRAM, { text: CAPTION, files: [PNG], dryRun: false }, FAST)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/create/i) });
  });
});

describe('[real-world fix] the right upload input', () => {
  test('the profile-photo input is NEVER used; the create-post input is found even outside the dialog', () => {
    at('/cuciqu.pro/', '<form><input id="avatar" type="file" accept="image/jpeg,image/png"></form><div role="dialog"><button>Select from computer</button></div>');
    const before = new Set(Array.from(document.querySelectorAll('input[type="file"]')));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(createPostInput(dialog, before)).toBeNull(); // only the avatar input exists → refuse
    const portal = document.createElement('form');
    portal.innerHTML = '<input id="create" type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime" style="display:none">';
    document.body.appendChild(portal);
    expect(createPostInput(dialog, before)?.id).toBe('create');
  });

  test('a failure message describes the screen (buttons, windows) so it can be fixed precisely', () => {
    at('/cuciqu.pro/', '<div role="dialog"><h1>Create new post</h1><div role="button">Back</div><div role="button">Crop</div></div>');
    expect(describeScreen()).toBe('[Screen: 1 window(s), title "Create new post"; buttons: "Back", "Crop"; upload inputs: 0; editors: none]');
    document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', '<div contenteditable="true" aria-label="Write a caption..."></div>');
    expect(describeScreen()).toContain('editors: <div aria-label="Write a caption..." contenteditable="true">');
  });
});

describe('[real-world] caption box in any markup', () => {
  test.each([
    ['contenteditable without role', '<div contenteditable="true" aria-label="Write a caption..."><p><br></p></div>'],
    ['plaintext-only editor', '<div contenteditable="plaintext-only"></div>'],
    ['editor inside an aria-hidden wrapper', '<div aria-hidden="true"><div contenteditable="true"></div></div>'],
    ['textarea', '<textarea></textarea>'],
  ])('%s is found inside the create window', (_name, html) => {
    at('/cuciqu.pro/', `<div role="dialog"><h1>Create new post</h1><div role="button">Share</div>${html}</div>`);
    expect(captionBox(INSTAGRAM, document.querySelector('[role="dialog"]')!)).not.toBeNull();
  });

  test('contenteditable="false" is never taken as the caption box', () => {
    at('/cuciqu.pro/', '<div role="dialog"><div contenteditable="false">x</div></div>');
    expect(captionBox(INSTAGRAM, document.querySelector('[role="dialog"]')!)).toBeNull();
  });
});

test('caption counter is read in English and Indonesian number formats', () => {
  at('/x/', '<div role="dialog"><div role="button">0/2,200</div></div>');
  expect(captionCounter(document)).toBe(0);
  at('/x/', '<div role="dialog"><span>57/2.200</span></div>');
  expect(captionCounter(document)).toBe(57);
  at('/x/', '<div role="dialog"><span>1,234 / 2,200</span></div>');
  expect(captionCounter(document)).toBe(1234);
  at('/x/', '<div role="dialog"><span>no counter</span></div>');
  expect(captionCounter(document)).toBeNull();
});

test('counter must show (most of) the caption: a lone space or a fraction never counts', () => {
  const text = 'Laundry rapi tanpa ribet bersama CuciQu setiap hari'; // 51 characters
  expect(counterMatches(1, text)).toBe(false); // only the space → the bug that posted an empty caption
  expect(counterMatches(20, text)).toBe(false);
  expect(counterMatches(51, text)).toBe(true);
  expect(counterMatches(52, text)).toBe(true); // + the trailing space
  expect(counterMatches(null, text)).toBe(false); // no counter on screen → cannot prove it → no Share
});

describe('Instagram confirmation', () => {
  const FP = fingerprint(CAPTION);

  test('profile grid → newest post links; pinned posts are skipped', async () => {
    at(
      '/cuciqu.pro/',
      '<main><a href="/cuciqu.pro/p/PIN111/"><svg aria-label="Pinned post icon"></svg></a><a href="/cuciqu.pro/p/AAA111/">x</a><a href="/p/BBB222/?img_index=1">y</a><a href="/reel/CCC333/">z</a><a href="/explore/">e</a></main>',
    );
    expect((await runInstagramRecent(INSTAGRAM, 2, FAST)).urls).toEqual(['http://localhost:3000/cuciqu.pro/p/AAA111/', 'http://localhost:3000/p/BBB222/']);
  });

  test('our caption on the post page is found (hashtags ignored); another caption is not', async () => {
    at('/p/AAA111/', `<main><article><h1>${CAPTION} #promo</h1></article></main>`);
    expect(await runInstagramFindPost(FP, undefined, FAST)).toEqual({ found: true, url: 'http://localhost:3000/p/AAA111/' });
    at('/p/BBB222/', '<main><article><h1>Postingan lain sama sekali tentang setrika</h1></article></main>');
    expect((await runInstagramFindPost(FP, undefined, FAST)).found).toBe(false);
  });

  test('[review#3] our text only in a COMMENT does not count', async () => {
    at('/p/CCC333/', `<main><article><h1>Caption yang berbeda sama sekali ya kak</h1><ul><li><span>${CAPTION}</span></li></ul></article></main>`);
    expect((await runInstagramFindPost(FP, undefined, FAST)).found).toBe(false);
  });

  test('[review#3] right after sharing, an OLDER post with the same caption is not ours', async () => {
    const shareAt = Date.parse('2026-11-10T03:00:00Z');
    at('/p/OLD/', `<main><article><h1>${CAPTION}</h1><time datetime="2026-11-01T03:00:00.000Z"></time></article></main>`);
    expect((await runInstagramFindPost(FP, shareAt, FAST)).found).toBe(false);
    at('/p/NEW/', `<main><article><h1>${CAPTION}</h1><time datetime="2026-11-10T03:01:00.000Z"></time></article></main>`);
    expect((await runInstagramFindPost(FP, shareAt, FAST)).found).toBe(true);
  });

  test('[review#2] a too-short fingerprint never matches anything', async () => {
    at('/p/X/', '<main><article><h1>hi</h1></article></main>');
    expect((await runInstagramFindPost('hi', undefined, FAST)).found).toBe(false);
  });
});
