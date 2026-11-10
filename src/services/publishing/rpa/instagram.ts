/**
 * Content-script side of Instagram FEED posting. Instagram's order differs from Facebook/Threads:
 * media FIRST (Create → Post → file), then Next (crop) → Next (edit), then the caption, then Share.
 * Pure DOM logic (no chrome.* APIs) so it is unit-testable against fixtures.
 *
 * Safety rules (same as the other platforms):
 * - Everything before clicking Share that goes wrong is 'failed' (nothing was posted).
 * - After clicking Share the outcome is 'clicked' only when Instagram confirms it, otherwise 'unknown',
 *   so the queue checks the profile before ever trying again (never a double post).
 */
import { attachFiles, click, closeSuggestions, dataUrlToFile, findBySelectors, humanDelay, sleep, waitFor } from './dom';
import type { EngineOpts, EngineResult, PreflightResult, PublishInput } from './engine';
import { normalizeText } from '../fingerprint';
import type { PlatformSelectors } from './selectors/types';

const T = (o: EngineOpts, ms: number) => Math.min(ms, o.timeoutMs ?? ms);

/** "https://www.instagram.com/cuciqu.pro/" → "cuciqu.pro" */
export function instagramHandle(profileUrl: string): string | null {
  try {
    const u = new URL(profileUrl);
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    const h = u.pathname.split('/').filter(Boolean)[0];
    return h && /^[A-Za-z0-9._]{1,30}$/.test(h) && !['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct'].includes(h.toLowerCase()) ? h.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function runInstagramPreflight(cfg: PlatformSelectors, account: { profileUrl: string }, o: EngineOpts = {}): Promise<PreflightResult> {
  await waitFor(() => findBySelectors(cfg.loggedOut) || findBySelectors(cfg.ownProfileProof), T(o, 15_000), o.pollMs);
  if (/\/accounts\/login/.test(location.pathname) || findBySelectors(cfg.loggedOut)) {
    return { ok: false, reason: 'Not logged in to Instagram in this Chrome profile. Log in at instagram.com, then try again.' };
  }
  const handle = instagramHandle(account.profileUrl);
  if (!handle) return { ok: false, reason: 'Instagram profile URL must look like https://www.instagram.com/username/' };
  const onProfile = location.pathname.toLowerCase().replace(/\/+$/, '') === `/${handle}`;
  if (!onProfile || !findBySelectors(cfg.ownProfileProof)) {
    return { ok: false, reason: `Logged-in Instagram account is not @${handle} (no "Edit profile" on its profile). Switch account on instagram.com.` };
  }
  return { ok: true };
}

/** Every element matching any of the selectors (text/label filters applied via findBySelectors on each candidate). */
function allMatches(list: PlatformSelectors['createMenuItem']): Element[] {
  const out: Element[] = [];
  for (const sel of list ?? []) {
    for (const el of Array.from(document.querySelectorAll(sel.css))) {
      if (el.parentElement && findBySelectors([sel], el.parentElement) === el) out.push(el);
    }
  }
  return out;
}

/**
 * The upload input of the create-post window. Instagram hides it (display:none) and may render it outside the
 * dialog element, so: an input inside the dialog, or else a NEW input (not there before Create) that also accepts
 * video — the profile-photo input accepts images only and existed before, so it can never be chosen.
 */
export function createPostInput(dialog: Element, before: Set<Element>): HTMLInputElement | null {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((i) => !before.has(i));
  return all.find((i) => dialog.contains(i)) ?? all.find((i) => /video/i.test(i.accept)) ?? null;
}

/** Short description of what is on screen, added to failure messages so a UI change can be fixed precisely. */
export function describeScreen(): string {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  const scope = dialogs.at(-1) ?? document.body;
  const buttons = Array.from(scope.querySelectorAll('[role="button"], button'))
    .map((b) => ((b.textContent ?? '').trim() || b.getAttribute('aria-label') || b.querySelector('svg[aria-label]')?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 30))
    .filter(Boolean)
    .slice(0, 10);
  const heading = (scope.querySelector('h1, h2, [role="heading"]')?.textContent ?? '').trim().slice(0, 40);
  const editors = Array.from(scope.querySelectorAll('[contenteditable], textarea'))
    .slice(0, 3)
    .map((e) => `<${e.tagName.toLowerCase()}${['role', 'aria-label', 'contenteditable', 'aria-hidden'].map((a) => (e.getAttribute(a) != null ? ` ${a}="${e.getAttribute(a)}"` : '')).join('')}>`);
  return `[Screen: ${dialogs.length} window(s)${heading ? `, title "${heading}"` : ''}; buttons: ${buttons.map((b) => `"${b}"`).join(', ') || 'none'}; upload inputs: ${document.querySelectorAll('input[type="file"]').length}; editors: ${editors.join(' ') || 'none'}]`;
}

/**
 * The caption box of the create-post window: the configured selectors first, then — because Instagram changes its
 * markup — ANY editable element inside that window (no attribute or visibility assumptions).
 */
export function captionBox(cfg: PlatformSelectors, dialog: Element): HTMLElement | null {
  return (
    findBySelectors(cfg.textbox, dialog) ??
    Array.from(dialog.querySelectorAll<HTMLElement>('[contenteditable]')).find((e) => e.getAttribute('contenteditable') !== 'false') ??
    dialog.querySelector<HTMLElement>('textarea')
  );
}

/** Instagram's caption counter ("0/2,200", "57/2.200") → the number typed; null when there is no counter on screen. */
export function captionCounter(root: ParentNode): number | null {
  for (const el of Array.from(root.querySelectorAll('[role="button"], span, div'))) {
    const m = /^\s*([\d.,]+)\s*\/\s*2[.,]?200\s*$/.exec(el.textContent ?? '');
    if (m) return Number(m[1].replace(/[.,]/g, ''));
  }
  return null;
}

/** Number of characters as Instagram counts them, roughly (graphemes). */
export function visibleChars(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())].length;
}

/** Instagram's counter shows (at least most of) the caption: the text really is in the post, not only on screen. */
export function counterMatches(n: number | null, text: string): boolean {
  if (n === null) return false;
  const want = visibleChars(text);
  return n >= Math.max(1, Math.floor(want * 0.8)) && n <= want * 2 + 5;
}

function caretToEnd(h: HTMLElement) {
  h.focus();
  const sel = window.getSelection();
  if (sel && document.createRange) {
    const r = document.createRange();
    r.selectNodeContents(h);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

function clearBox(h: HTMLElement) {
  h.focus();
  const sel = window.getSelection();
  if (sel && document.createRange) {
    const r = document.createRange();
    r.selectNodeContents(h);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  if (typeof document.execCommand === 'function') document.execCommand('delete');
}

const exec = (cmd: string, value?: string) => typeof document.execCommand === 'function' && document.execCommand(cmd, false, value);

/**
 * Puts the caption into Instagram's editor and PROVES it with Instagram's own counter. Tries, in order: paste,
 * insert-all, line-by-line, and typing character by character; after each, the counter must show (most of) the
 * caption, otherwise the box is cleared and the next method is tried. Text that is only on screen never passes.
 */
export async function typeCaption(box: HTMLElement, text: string, root: ParentNode, o: EngineOpts = {}): Promise<{ ok: true; proof: string } | { ok: false; tried: string[] }> {
  const methods: [string, () => Promise<void>][] = [
    [
      'paste',
      async () => {
        caretToEnd(box);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
    ],
    [
      'insert',
      async () => {
        caretToEnd(box);
        exec('insertText', text);
      },
    ],
    [
      'lines',
      async () => {
        caretToEnd(box);
        text.split('\n').forEach((line, i) => {
          if (i > 0 && !exec('insertParagraph')) exec('insertLineBreak');
          if (line) exec('insertText', line);
        });
      },
    ],
    [
      'keys',
      async () => {
        caretToEnd(box);
        for (const ch of [...text]) {
          if (ch !== '\n') exec('insertText', ch);
          else if (!exec('insertParagraph')) exec('insertLineBreak');
          await sleep(o.delay === false ? 0 : 8);
        }
      },
    ],
  ];
  const tried: string[] = [];
  for (const [name, run] of methods) {
    if (tried.length) {
      clearBox(box);
      await sleep(150);
    }
    try {
      await run();
    } catch {
      /* this method is unavailable here — try the next */
    }
    const n = await waitFor(() => (counterMatches(captionCounter(root), text) ? captionCounter(root) : null), T(o, 2500), o.pollMs);
    if (n !== null) {
      // A trailing #hashtag opens a suggestion list that blocks Share: end it with a space like a person would.
      await closeSuggestions(box, text);
      const after = captionCounter(root);
      if (counterMatches(after, text)) return { ok: true, proof: `${name}, counter ${after}/2,200` };
      tried.push(`${name}=${after ?? 'none'}(lost after closing suggestions)`);
      continue;
    }
    tried.push(`${name}=${captionCounter(root) ?? 'no counter'}`);
  }
  return { ok: false, tried };
}

/** What a step of the create window looks like (title + button labels): changes when Instagram moves to the next step. */
function screenSignature(dlg: Element): string {
  const title = dlg.querySelector('h1, h2, [role="heading"]')?.textContent ?? '';
  const buttons = Array.from(dlg.querySelectorAll('[role="button"], button')).map((b) => (b.textContent ?? '').trim()).join('|');
  return `${title}#${buttons}#${dlg.querySelectorAll('[contenteditable], img, video').length}`;
}

/** The create-post dialog: the one holding the file input, a "Select from computer" button, Next, or the caption box. */
function createDialog(cfg: PlatformSelectors): Element | null {
  for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
    if (findBySelectors(cfg.fileInput, d) || findBySelectors(cfg.mediaButton, d) || findBySelectors(cfg.nextButton, d) || captionBox(cfg, d)) return d;
  }
  return null;
}

export async function runInstagramPublish(cfg: PlatformSelectors, input: PublishInput, o: EngineOpts = {}): Promise<EngineResult> {
  const d = o.delay !== false;
  if (!input.files.length) return { status: 'failed', reason: 'Instagram posts need an image or video — add one from the Media Library' };
  if (input.files.length > 1) return { status: 'failed', reason: 'Only one image or video per Instagram post is supported for now (no carousel yet)' };

  // 1. Create → (Post)
  const opener = await waitFor(() => findBySelectors(cfg.composerOpen), T(o, 15_000), o.pollMs);
  if (!opener) return { status: 'failed', reason: 'Could not find the Instagram "Create" button (UI changed or not logged in)' };
  // Elements that already say "Post"/"Postingan" (e.g. the profile's Posts tab) are NOT the Create menu item:
  // only an item that appears after clicking Create is accepted.
  const before = new Set(allMatches(cfg.createMenuItem));
  // Same for file inputs: the profile page has its own (profile photo!). Only one that appears after Create may be used.
  const inputsBefore = new Set(Array.from(document.querySelectorAll('input[type="file"]')));
  await humanDelay(d);
  click(opener);
  const newMenuItem = () => allMatches(cfg.createMenuItem).find((el) => !before.has(el)) ?? null;
  let dialog: Element | null = await waitFor(() => createDialog(cfg) ?? newMenuItem(), T(o, 10_000), o.pollMs);
  if (dialog && !createDialog(cfg)) {
    // A small menu (Post / Reel / Live…) opened first.
    await humanDelay(d);
    click(dialog);
    dialog = await waitFor(() => createDialog(cfg), T(o, 10_000), o.pollMs);
  }
  if (!dialog) return { status: 'failed', reason: `The "Create new post" window did not open. ${describeScreen()}` };

  // 2. Media — never a file input that existed before Create (that could be the profile-photo uploader).
  await humanDelay(d);
  const createDlg = dialog;
  const fileInput = await waitFor(() => createPostInput(createDlg, inputsBefore), T(o, 8000), o.pollMs);
  if (!fileInput) return { status: 'failed', reason: `Could not find the upload input of the "Create new post" window. ${describeScreen()}` };
  attachFiles(fileInput, input.files.map((f) => dataUrlToFile(f.name, f.type, f.dataUrl)));

  // Videos: Instagram may first say "Video posts are now shared as reels" — acknowledge with OK.
  if (input.files[0].type.startsWith('video/')) {
    const ok = await waitFor(() => {
      const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((x) => /reel/i.test(x.textContent ?? ''));
      return dlg ? findBySelectors(cfg.reelsNoticeOk, dlg) : null;
    }, T(o, 4000), o.pollMs);
    if (ok) click(ok);
  }

  // 3. Next (crop) → Next (edit) until the caption box appears.
  // Instagram animates between screens and the old Next button stays on screen meanwhile: after each click, wait
  // until the screen has really changed before looking again (clicking it twice skipped steps / used up the tries).
  let box: HTMLElement | null = null;
  const deadline = Date.now() + T(o, 90_000);
  for (let clicks = 0; clicks < 6 && !box && Date.now() < deadline; clicks++) {
    const found = await waitFor(() => {
      const dlg = createDialog(cfg);
      const tb = dlg && captionBox(cfg, dlg);
      if (tb) return { tb };
      const next = dlg && findBySelectors(cfg.nextButton, dlg);
      return next && dlg && next.getAttribute('aria-disabled') !== 'true' ? { next, dlg } : null;
    }, Math.max(0, Math.min(T(o, clicks === 0 ? 45_000 : 20_000), deadline - Date.now())), o.pollMs);
    if (!found) break;
    if ('tb' in found) {
      box = found.tb ?? null;
      break;
    }
    const before = screenSignature(found.dlg);
    await humanDelay(d, 600, 1200);
    click(found.next);
    await waitFor(() => {
      const dlg = createDialog(cfg);
      return !document.contains(found.next) || !dlg || (!!captionBox(cfg, dlg)) || screenSignature(dlg) !== before;
    }, T(o, 15_000), o.pollMs);
  }
  if (!box) return { status: 'failed', reason: `Media did not upload, or the caption step did not appear (caption box / Next button not found). ${describeScreen()} (v${cfg.version})` };

  // 4. Caption
  let captionProof = '';
  if (input.text.trim()) {
    await humanDelay(d);
    const dlg = createDialog(cfg) ?? document;
    const r = await typeCaption(box, input.text, dlg, o);
    if (!r.ok) {
      return {
        status: 'failed',
        reason: `The caption was not accepted by Instagram — not shared. Counter after each method: ${r.tried.join(', ')} (expected ~${visibleChars(input.text)}). ${describeScreen()} (v${cfg.version})`,
      };
    }
    captionProof = r.proof;
  }
  if (input.dryRun) return { status: 'dry-run', note: captionProof ? `Caption is in Instagram's editor (${captionProof})` : undefined };

  // 5. Share
  await humanDelay(d, 800, 1600);
  const share = await waitFor(() => {
    const dlg = createDialog(cfg) ?? document;
    const b = findBySelectors(cfg.postButton, dlg);
    return b && b.getAttribute('aria-disabled') !== 'true' ? b : null;
  }, T(o, 20_000), o.pollMs);
  if (!share) return { status: 'failed', reason: 'Share button not found or disabled' };
  click(share);

  // From here on: never 'failed' — only Instagram's own confirmation counts as success.
  try {
    const outcome = await waitFor(() => (findBySelectors(cfg.sharedNotice) ? 'shared' : findBySelectors(cfg.shareError) ? 'error' : null), T(o, 180_000), o.pollMs);
    if (outcome === 'shared') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { status: 'clicked', ...(captionProof ? { note: `Caption: ${captionProof}` } : {}) };
    }
    if (outcome === 'error') return { status: 'unknown', reason: 'Instagram reported that the post could not be shared' };
    return { status: 'unknown', reason: 'No "post shared" confirmation from Instagram' };
  } catch (e) {
    return { status: 'unknown', reason: `Error after clicking Share: ${(e as Error).message}` };
  }
}

const PINNED_RE = /pinned|disematkan|sematan/i;

/**
 * Profile grid: links of the newest posts (Instagram's grid shows images only, so captions must be read per post).
 * Pinned posts are skipped: they sit first in the grid but are old.
 */
export async function runInstagramRecent(cfg: PlatformSelectors, max: number, o: EngineOpts = {}): Promise<{ urls: string[] }> {
  const re = new RegExp(cfg.permalink);
  const urls = await waitFor(() => {
    const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      const m = href.match(re);
      if (!m) continue;
      const pinned = Array.from(a.querySelectorAll('svg[aria-label], [aria-label], title')).some((x) => PINNED_RE.test(x.getAttribute('aria-label') ?? x.textContent ?? ''));
      if (pinned) continue;
      seen.add(new URL(href.slice(0, href.indexOf(m[0]) + m[0].length) + '/', location.origin).toString());
      if (seen.size >= max) break;
    }
    return seen.size ? [...seen] : null;
  }, T(o, 12_000), o.pollMs);
  return { urls: urls ?? [] };
}

/** Visible text with line breaks kept as spaces (textContent would glue "line1<br>line2" together). */
const textOf = (el: Element) => (el as HTMLElement).innerText ?? el.textContent ?? '';

/**
 * On a single post page: is this OUR post? Only the CAPTION is compared (never the comments), the whole fingerprint
 * must match, and — right after sharing — the post must not be older than `sinceMs` (an older post with a similar
 * caption is not ours).
 */
export async function runInstagramFindPost(fp: string, sinceMs?: number, o: EngineOpts = {}): Promise<{ found: boolean; url?: string }> {
  if (fp.length < 20) return { found: false };
  const hit = await waitFor(() => {
    const scope = document.querySelector('article') ?? document.querySelector('main');
    const caption = scope?.querySelector('h1');
    if (!caption) return null;
    if (!normalizeText(textOf(caption)).includes(fp)) return 'no' as const;
    if (sinceMs) {
      const t = Date.parse(scope?.querySelector('time[datetime]')?.getAttribute('datetime') ?? '');
      if (Number.isFinite(t) && t < sinceMs - 10 * 60_000) return 'no' as const;
    }
    return 'yes' as const;
  }, T(o, 10_000), o.pollMs);
  return hit === 'yes' ? { found: true, url: location.href.replace(/[?#].*$/, '') } : { found: false };
}
