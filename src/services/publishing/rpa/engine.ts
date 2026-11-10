/**
 * Content-script side of RPA publishing. Runs inside the Threads / Facebook tab.
 * Pure DOM logic (no chrome.* APIs) so it is unit-testable against fixtures.
 */
import { normalizeText } from '../fingerprint';
import { attachFiles, click, closeSuggestions, dataUrlToFile, findBySelectors, humanDelay, readEditorText, typeText, waitFor } from './dom';
import type { PlatformSelectors } from './selectors/types';

export interface EngineOpts {
  timeoutMs?: number;
  pollMs?: number;
  delay?: boolean;
}
export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Facebook: we clicked "Switch now"; caller should reload and run preflight again */
  switched?: boolean;
}
export interface PublishInput {
  text: string;
  files: { name: string; type: string; dataUrl: string }[];
  dryRun: boolean;
  pageName?: string;
  /** Threads topic / community tag; best effort */
  topic?: string;
}
/** `note`: extra evidence for the user (e.g. Instagram: how the caption got into the editor and its counter). */
export type EngineResult = { status: 'clicked'; pending?: boolean; topicSet?: boolean; topicIssue?: string; note?: string } | { status: 'dry-run'; topicIssue?: string; note?: string } | { status: 'unknown'; reason: string } | { status: 'failed'; reason: string };

const T = (o: EngineOpts, ms: number) => Math.min(ms, o.timeoutMs ?? ms);

function handleFrom(profileUrl: string): string | null {
  return profileUrl.match(/\/@([A-Za-z0-9._]+)/)?.[1]?.toLowerCase() ?? null;
}

export async function runPreflight(
  cfg: PlatformSelectors,
  account: { profileUrl: string; pageName?: string },
  o: EngineOpts = {},
): Promise<PreflightResult> {
  const name = cfg.platform === 'threads' ? 'Threads' : 'Facebook';
  // Let the SPA render something meaningful first.
  await waitFor(
    () => findBySelectors(cfg.loggedOut) || findBySelectors(cfg.ownProfileProof) || findBySelectors(cfg.switchToPage) || findBySelectors(cfg.notMember),
    T(o, 15_000),
    o.pollMs,
  );
  if (/\/login/.test(location.pathname) || findBySelectors(cfg.loggedOut)) {
    return { ok: false, reason: `Not logged in to ${name} in this Chrome profile. Log in, then try again.` };
  }
  if (cfg.platform === 'threads') {
    const handle = handleFrom(account.profileUrl);
    if (!handle) return { ok: false, reason: 'Threads profile URL must look like https://www.threads.com/@username' };
    const onProfile = location.pathname.toLowerCase().startsWith(`/@${handle}`);
    if (!onProfile || !findBySelectors(cfg.ownProfileProof)) {
      return { ok: false, reason: `Logged-in Threads account is not @${handle} (no "Edit profile" on its profile).` };
    }
    return { ok: true };
  }
  if (cfg.platform === 'fbgroup') {
    if (/this group is paused|grup ini dijeda|grup ini dihentikan sementara/i.test(document.body?.innerText ?? document.body?.textContent ?? '')) {
      return { ok: false, reason: 'Group is paused by its admin — nobody can post.' };
    }
    if (!findBySelectors(cfg.ownProfileProof)) {
      return { ok: false, reason: 'Not a member of this group, or posting is turned off for you. Join the group first.' };
    }
    return { ok: true };
  }
  // Facebook Page
  if (!findBySelectors(cfg.ownProfileProof)) {
    const sw = findBySelectors(cfg.switchToPage);
    if (sw) {
      click(sw);
      return { ok: false, switched: true, reason: 'Switched into the Page; reload required' };
    }
    return {
      ok: false,
      reason: `Facebook is not posting as the Page "${account.pageName ?? ''}". Switch into the Page (profile menu → switch to Page) and try again.`,
    };
  }
  return { ok: true };
}

export async function runPublish(cfg: PlatformSelectors, input: PublishInput, o: EngineOpts = {}): Promise<EngineResult> {
  const d = o.delay !== false;
  // The composer may already be open (Threads compose intent URL); otherwise click the opener.
  const preOpened = /^\/intent\//.test(location.pathname)
    ? await waitFor(() => findBySelectors(cfg.composerDialog), T(o, 15_000), o.pollMs)
    : findBySelectors(cfg.composerDialog);
  if (!preOpened) {
    const opener = await waitFor(() => findBySelectors(cfg.composerOpen), T(o, 15_000), o.pollMs);
    if (!opener) return { status: 'failed', reason: 'Could not find the "create post" button (UI changed or not logged in)' };
    await humanDelay(d);
    click(opener);
  }

  const dialog = await waitFor(() => {
    // Ignore unrelated dialogs (notifications, account menus) and wait for the real editor.
    for (const el of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      if (findBySelectors(cfg.textbox, el)) return el;
    }
    return null;
  }, T(o, 15_000), o.pollMs);
  const box = dialog && (await waitFor(() => findBySelectors(cfg.textbox, dialog), T(o, 10_000), o.pollMs));
  if (!dialog || !box) return { status: 'failed', reason: 'Composer did not open' };

  if (cfg.platform === 'facebook') {
    const pageName = normalizeText(input.pageName ?? '');
    // The author may only appear as an avatar label/alt text, not as visible text.
    const attrs = Array.from(dialog.querySelectorAll('[aria-label], img[alt], svg[aria-label], image'))
      .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''}`)
      .join(' ');
    const author = normalizeText(`${dialog.textContent ?? ''} ${attrs}`);
    if (!pageName || !author.includes(pageName)) {
      const seen = (dialog.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        status: 'failed',
        reason: `Composer is not posting as the Page "${input.pageName ?? ''}" — not posted. Composer shows: "${seen}". Switch Facebook to your Page (profile menu → the Page) or fix the Page name in Social Accounts.`,
      };
    }
  }

  if (input.files.length) {
    await humanDelay(d);
    let fileInput = findBySelectors<HTMLInputElement>(cfg.fileInput, dialog);
    if (!fileInput && cfg.mediaButton) {
      const mb = findBySelectors(cfg.mediaButton, dialog);
      if (mb) click(mb);
      fileInput = await waitFor(() => findBySelectors<HTMLInputElement>(cfg.fileInput, dialog) ?? findBySelectors<HTMLInputElement>(cfg.fileInput), T(o, 5000), o.pollMs);
    }
    if (!fileInput) return { status: 'failed', reason: 'Could not find the media upload input' };
    attachFiles(fileInput, input.files.map((f) => dataUrlToFile(f.name, f.type, f.dataUrl)));
    const previews = await waitFor(
      () => {
        const n = cfg.mediaPreview.reduce((s, sel) => s + dialog.querySelectorAll(sel.css).length, 0);
        return n >= input.files.length ? n : 0;
      },
      T(o, 45_000),
      o.pollMs,
    );
    if (!previews) return { status: 'failed', reason: 'Media did not attach (no preview appeared)' };
  }

  await humanDelay(d);
  const typed = await typeText(box, input.text);
  if (!typed) {
    const seen = readEditorText(box).replace(/\s+/g, ' ').trim();
    return {
      status: 'failed',
      reason: `Text could not be entered exactly into the composer (expected ${input.text.replace(/\s+/g, ' ').trim().length} chars, editor shows ${seen.length}: "${seen.slice(0, 80)}…")`,
    };
  }
  await closeSuggestions(box, input.text); // a trailing #hashtag opens a suggestion list that blocks Post
  let topicSet: boolean | undefined;
  let topicIssue: string | undefined;
  if (input.topic && cfg.topicField) {
    topicIssue = (await setTopic(cfg, dialog, box, input.topic, o)) ?? undefined;
    topicSet = !topicIssue;
  }
  if (input.dryRun) return { status: 'dry-run', topicIssue };

  await humanDelay(d, 800, 1600);
  const next = cfg.nextButton && findBySelectors(cfg.nextButton, dialog);
  if (next) {
    click(next);
    await humanDelay(d, 800, 1500);
  }
  const post = await waitFor(
    () => {
      const b = findBySelectors(cfg.postButton, document.querySelector('[role="dialog"]') ?? document);
      return b && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    },
    T(o, 30_000),
    o.pollMs,
  );
  if (!post) return { status: 'failed', reason: 'Post button not found or disabled' };
  click(post);
  // From here on the outcome is ambiguous unless the composer closes — never report 'failed'.
  try {
    const closed = await waitFor(() => !document.contains(dialog) || (dialog as HTMLElement).getAttribute('aria-hidden') === 'true', T(o, 60_000), o.pollMs);
    if (!closed) return { status: 'unknown', reason: 'Composer did not close after clicking Post' };
    if (cfg.pendingNotice && (await waitFor(() => findBySelectors(cfg.pendingNotice), T(o, 8000), o.pollMs))) {
      return { status: 'clicked', pending: true };
    }
    return { status: 'clicked', topicSet, topicIssue };
  } catch (e) {
    return { status: 'unknown', reason: `Error after clicking Post: ${(e as Error).message}` };
  }
}

export async function runFindExisting(cfg: PlatformSelectors, fp: string, o: EngineOpts = {}): Promise<{ found: boolean; url?: string }> {
  if (!fp) return { found: false };
  const re = new RegExp(cfg.permalink);
  const hit = await waitFor(
    () => {
      // Facebook cuts long posts with "See more", so the full 60-char fingerprint may not be on the page:
      // also accept its first 40 characters (still specific enough to identify our own post).
      const short = fp.slice(0, 40).trim();
      for (const c of Array.from(document.querySelectorAll(cfg.postContainer))) {
        const t = normalizeText(c.textContent ?? '');
        if (t.includes(fp) || (short.length >= 25 && t.includes(short))) return c;
      }
      return null;
    },
    T(o, 10_000),
    o.pollMs,
  );
  if (!hit) return { found: false };
  const a = Array.from(hit.querySelectorAll<HTMLAnchorElement>('a[href]')).find((x) => re.test(x.getAttribute('href') ?? ''));
  return { found: true, url: a ? new URL(a.getAttribute('href')!, location.origin).toString().replace(/\?.*$/, '') : undefined };
}

const TOPIC_RE = /community or topic|add a topic|komunitas atau topik|tambahkan topik/i;

/** Fallback: the topic field may show its hint via placeholder / aria / data attributes or a pseudo-element. */
export function findTopicField(dialog: Element): HTMLElement | null {
  const els = Array.from(dialog.querySelectorAll<HTMLElement>('*'));
  for (const el of els) {
    for (const a of ['placeholder', 'aria-placeholder', 'data-placeholder', 'aria-label']) {
      if (TOPIC_RE.test(el.getAttribute(a) ?? '')) return el;
    }
  }
  // innermost element whose own text is the hint
  const textHits = els.filter((el) => TOPIC_RE.test((el.textContent ?? '').trim()) && (el.textContent ?? '').trim().length < 40);
  const inner = textHits.find((el) => !textHits.some((o) => o !== el && el.contains(o)));
  return inner ? ((inner.closest('[role="button"], [contenteditable="true"], input') as HTMLElement | null) ?? inner) : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Fills the Threads "Community or topic" field. Best effort: never blocks the post.
 * Returns null on success, or a short reason (shown on the post) when the UI differs.
 */
export async function setTopic(cfg: PlatformSelectors, dialog: Element, box: Element, topic: string, o: EngineOpts = {}): Promise<string | null> {
  try {
    const field = findBySelectors(cfg.topicField, dialog) ?? findTopicField(dialog);
    if (!field) return 'topic field not found';
    const isEditable = (el: Element | null): el is HTMLElement =>
      !!el && el !== box && !box.contains(el) && ((el as HTMLElement).tagName === 'INPUT' || (el as HTMLElement).isContentEditable);
    const before = new Set(Array.from(document.querySelectorAll('input, [contenteditable="true"]')));
    click(field);
    const editable = await waitFor(
      () => {
        const a = document.activeElement;
        if (isEditable(a)) return a;
        if (isEditable(field)) return field as HTMLElement;
        // an input that appeared after the click (inline editor or popover search box)
        const fresh = Array.from(document.querySelectorAll<HTMLElement>('input, [contenteditable="true"]')).find((el) => !before.has(el) && isEditable(el));
        if (fresh) return fresh;
        return Array.from(document.querySelectorAll<HTMLElement>('input, [contenteditable="true"]')).find(
          (el) => isEditable(el) && TOPIC_RE.test(`${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('aria-placeholder') ?? ''}`),
        );
      },
      T(o, 4000),
      o.pollMs,
    );
    if (!editable) return 'topic input did not open';
    editable.focus();
    if (editable.tagName === 'INPUT') {
      const inp = editable as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(inp, topic);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (!document.execCommand('insertText', false, topic)) {
      editable.textContent = topic;
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: topic }));
    }
    const want = norm(topic);
    const option = await waitFor(
      () => {
        const listed = (cfg.topicOption ?? []).flatMap((sel) => [...document.querySelectorAll<HTMLElement>(sel.css)]);
        const hit = listed.find((el) => norm(el.textContent ?? '').includes(want)) ?? listed[0];
        if (hit) return hit;
        // suggestion rows rendered as plain clickable divs: exact topic text outside the composer box
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], [role="menuitem"], [tabindex="0"]')).filter(
          (el) => el !== editable && !el.contains(editable) && !box.contains(el) && norm(el.textContent ?? '').startsWith(want),
        );
        return rows.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0] ?? null;
      },
      T(o, 5000),
      o.pollMs,
    );
    if (option) click(option);
    else {
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'no topic suggestion appeared (pressed Enter)';
    }
    return null;
  } catch (e) {
    return `topic error: ${(e as Error).message}`;
  }
}

export interface ScrapedPost {
  text: string;
  url?: string;
  /** likes + replies + reposts parsed from the counters; undefined when none could be read */
  engagement?: number;
}

/** Parses "1,2K" / "3.4rb" / "15" into a number. */
export function parseCount(s: string): number {
  const m = s.trim().toLowerCase().match(/^([\d.,]+)\s*(k|rb|jt|m)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  const mult = m[2] === 'k' || m[2] === 'rb' ? 1e3 : m[2] === 'jt' || m[2] === 'm' ? 1e6 : 1;
  return Number.isFinite(n) ? Math.round(n * mult) : 0;
}

/** Reads posts on a search/feed page (read-only). */
export async function runScrapeFeed(cfg: PlatformSelectors, max: number, o: EngineOpts = {}): Promise<{ posts: ScrapedPost[] }> {
  await waitFor(() => document.querySelector(cfg.postContainer), T(o, 15_000), o.pollMs);
  // Scroll a little so more results load.
  for (let i = 0; i < 3 && document.querySelectorAll(cfg.postContainer).length < max; i++) {
    window.scrollBy(0, 2000);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1200));
  }
  const re = new RegExp(cfg.permalink);
  const seen = new Set<string>();
  const posts: ScrapedPost[] = [];
  for (const c of Array.from(document.querySelectorAll<HTMLElement>(cfg.postContainer))) {
    const text = (c.innerText ?? c.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 30 || seen.has(text)) continue;
    seen.add(text);
    const a = Array.from(c.querySelectorAll<HTMLAnchorElement>('a[href]')).find((x) => re.test(x.getAttribute('href') ?? ''));
    // Only this post's own counters (not a quoted/nested post); undefined when no counter could be read.
    const counts = Array.from(c.querySelectorAll('[role="button"] span, button span'))
      .filter((el) => el.closest(cfg.postContainer) === c && /^\s*[\d.,]+\s*(k|rb|jt|m)?\s*$/i.test(el.textContent ?? ''))
      .map((el) => parseCount(el.textContent ?? ''));
    const engagement = counts.length ? counts.reduce((s, n) => s + n, 0) : undefined;
    posts.push({ text: text.slice(0, 600), url: a ? new URL(a.getAttribute('href')!, location.origin).toString() : undefined, engagement });
    if (posts.length >= max) break;
  }
  return { posts: posts.sort((x, y) => (y.engagement ?? 0) - (x.engagement ?? 0)) };
}

/** Strips activity suffixes Facebook glues to the name ("…Last active 3 days ago"). */
export function cleanGroupName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*(last active|you last visited|terakhir aktif|anda terakhir mengunjungi|aktif \d|\d+ (new )?posts?|\d+ postingan baru).*$/i, '')
    .trim();
}

const NOT_GROUP = new Set(['joins', 'feed', 'discover', 'create', 'search', 'notifications', 'your_groups', 'category', 'groups']);

/** Collects joined groups from facebook.com/groups/joins (read-only). */
export function collectGroups(root: ParentNode = document): { name: string; url: string }[] {
  const byId = new Map<string, string>();
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"]'))) {
    let u: URL;
    try {
      u = new URL(a.getAttribute('href')!, 'https://www.facebook.com');
    } catch {
      continue;
    }
    const m = u.pathname.match(/^\/groups\/([^/]+)\/?$/);
    if (!m || NOT_GROUP.has(m[1])) continue;
    const name = cleanGroupName(a.textContent ?? '');
    if (!name || /^(lihat grup|view group|kunjungi|visit)/i.test(name)) {
      if (!byId.has(m[1])) byId.set(m[1], '');
      continue;
    }
    if ((byId.get(m[1]) ?? '').length < name.length && name.length < 120) byId.set(m[1], name);
  }
  return [...byId].filter(([, n]) => n).map(([id, name]) => ({ name, url: `https://www.facebook.com/groups/${id}` }));
}

export async function runScrapeGroups(o: EngineOpts = {}): Promise<{ groups: { name: string; url: string }[] }> {
  await waitFor(() => document.querySelector('a[href*="/groups/"]'), T(o, 15_000), o.pollMs);
  let last = -1;
  for (let i = 0; i < 15; i++) {
    const n = collectGroups().length;
    if (n === last) break;
    last = n;
    window.scrollBy(0, 3000);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
  }
  return { groups: collectGroups() };
}
