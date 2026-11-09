/**
 * Content-script side of RPA publishing. Runs inside the Threads / Facebook tab.
 * Pure DOM logic (no chrome.* APIs) so it is unit-testable against fixtures.
 */
import { normalizeText } from '../fingerprint';
import { attachFiles, click, dataUrlToFile, findBySelectors, humanDelay, readEditorText, typeText, waitFor } from './dom';
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
export type EngineResult = { status: 'clicked'; pending?: boolean; topicSet?: boolean } | { status: 'dry-run' } | { status: 'unknown'; reason: string } | { status: 'failed'; reason: string };

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

  const dialog = await waitFor(() => findBySelectors(cfg.composerDialog), T(o, 15_000), o.pollMs);
  const box = dialog && (await waitFor(() => findBySelectors(cfg.textbox, dialog), T(o, 10_000), o.pollMs));
  if (!dialog || !box) return { status: 'failed', reason: 'Composer did not open' };

  if (cfg.platform === 'facebook') {
    const pageName = normalizeText(input.pageName ?? '');
    const author = normalizeText(dialog.textContent ?? '');
    if (!pageName || !author.includes(pageName)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { status: 'failed', reason: `Composer is not posting as the Page "${input.pageName ?? ''}" — not posted.` };
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
  let topicSet: boolean | undefined;
  if (input.topic && cfg.topicField) topicSet = await setTopic(cfg, dialog, box, input.topic, o);
  if (input.dryRun) return { status: 'dry-run' };

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
    if (cfg.pendingNotice && (await waitFor(() => findBySelectors(cfg.pendingNotice), T(o, 4000), o.pollMs))) {
      return { status: 'clicked', pending: true };
    }
    return { status: 'clicked', topicSet };
  } catch (e) {
    return { status: 'unknown', reason: `Error after clicking Post: ${(e as Error).message}` };
  }
}

export async function runFindExisting(cfg: PlatformSelectors, fp: string, o: EngineOpts = {}): Promise<{ found: boolean; url?: string }> {
  if (!fp) return { found: false };
  const re = new RegExp(cfg.permalink);
  const hit = await waitFor(
    () => {
      for (const c of Array.from(document.querySelectorAll(cfg.postContainer))) {
        if (normalizeText(c.textContent ?? '').includes(fp)) return c;
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fills the Threads "Community or topic" field. Best effort: returns false and moves on if the UI differs. */
export async function setTopic(cfg: PlatformSelectors, dialog: Element, box: Element, topic: string, o: EngineOpts = {}): Promise<boolean> {
  try {
    const field = findBySelectors(cfg.topicField, dialog);
    if (!field) return false;
    click(field);
    const editable = await waitFor(
      () => {
        const a = document.activeElement as HTMLElement | null;
        if (a && a !== box && (a.tagName === 'INPUT' || a.isContentEditable)) return a;
        const f = field as HTMLElement;
        return f.tagName === 'INPUT' || f.isContentEditable ? f : null;
      },
      T(o, 3000),
      o.pollMs,
    );
    if (!editable) return false;
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
        const opts = (cfg.topicOption ?? []).flatMap((s) => [...document.querySelectorAll<HTMLElement>(s.css)]);
        if (!opts.length) return null;
        return opts.find((el) => norm(el.textContent ?? '').includes(want)) ?? opts[0];
      },
      T(o, 5000),
      o.pollMs,
    );
    if (option) click(option);
    else editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  } catch {
    return false;
  }
}
