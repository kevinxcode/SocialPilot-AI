import type { Sel } from './selectors/types';

const visibleText = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const labelOf = (el: Element) =>
  el.getAttribute('aria-label') ?? el.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? '';

function matches(el: Element, s: Sel): boolean {
  if (s.text && !new RegExp(s.text, 'i').test(visibleText(el))) return false;
  if (s.label && !new RegExp(s.label, 'i').test(labelOf(el).trim())) return false;
  return true;
}

function isHidden(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.getAttribute('aria-hidden') === 'true') return true;
  // jsdom has no layout; only trust computed display/visibility
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(h) : null;
  return !!cs && (cs.visibility === 'hidden' || (cs.display === 'none' && h.tagName !== 'INPUT'));
}

/** First element matching any selector (in order). Prefers the innermost match for text selectors. */
export function findBySelectors<T extends Element = HTMLElement>(list: Sel[] | undefined, root: ParentNode = document): T | null {
  for (const s of list ?? []) {
    const all = Array.from(root.querySelectorAll(s.css)).filter((el) => matches(el, s) && !isHidden(el));
    if (!all.length) continue;
    // innermost: drop elements that contain another match
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    return (inner[0] ?? all[0]) as unknown as T;
  }
  return null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, pollMs = 250): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(pollMs);
  }
}

/** Small randomized pause to keep pacing human-like. */
export function humanDelay(enabled = true, min = 350, max = 900): Promise<void> {
  return enabled ? sleep(min + Math.random() * (max - min)) : Promise.resolve();
}

export function click(el: Element): void {
  const h = el as HTMLElement;
  h.scrollIntoView?.({ block: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    h.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  h.click();
}

/** Text of an editor as the user would see it (lines joined by \n). */
export function readEditorText(el: Element): string {
  const h = el as HTMLElement;
  if (h instanceof HTMLTextAreaElement || h instanceof HTMLInputElement) return h.value;
  const paragraphs = h.querySelectorAll(':scope > p, :scope > div');
  if (paragraphs.length) {
    return Array.from(paragraphs)
      .map((p) => (p.querySelector('br') && !p.textContent ? '' : (p.textContent ?? '')))
      .join('\n');
  }
  return (h.innerText && h.innerText !== 'undefined' ? h.innerText : h.textContent) ?? '';
}

const norm = (s: string) => s.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Content equality ignoring whitespace/line-break rendering differences (missing or duplicated text still fails). */
const squash = (s: string) => norm(s).replace(/\s+/g, '');
export function editorMatches(el: Element, text: string): boolean {
  return squash(readEditorText(el)) === squash(text);
}

async function settled(h: HTMLElement, text: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (editorMatches(h, text)) return true;
    if (Date.now() >= end) return false;
    await sleep(100);
  }
}

function clearEditor(h: HTMLElement) {
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

/**
 * Inserts text so React/Lexical editors register it. Strategy: synthetic paste →
 * execCommand insertText per line → direct DOM fallback (plain contenteditable / tests). Verified after each.
 */
export async function typeText(el: Element, text: string): Promise<boolean> {
  const h = el as HTMLElement;
  if (h instanceof HTMLTextAreaElement || h instanceof HTMLInputElement) {
    const proto = Object.getPrototypeOf(h);
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(h, text);
    h.dispatchEvent(new Event('input', { bubbles: true }));
    return h.value === text;
  }
  h.focus();

  // 1) paste — the most faithful path for Lexical (keeps emoji and line breaks)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    h.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    // Rich editors apply the paste asynchronously — wait for it instead of typing a second copy.
    if (await settled(h, text, 2000)) return true;
  } catch {
    /* DataTransfer/ClipboardEvent unavailable */
  }

  // 2) execCommand line by line
  if (typeof document.execCommand === 'function') {
    clearEditor(h);
    let ok = true;
    text.split('\n').forEach((line, i) => {
      if (i > 0) ok = document.execCommand('insertLineBreak') || document.execCommand('insertParagraph') || ok;
      if (line) ok = document.execCommand('insertText', false, line) && ok;
    });
    if (await settled(h, text, 1500)) return true;
  }

  // 3) direct DOM (non-framework editors)
  h.textContent = text;
  h.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  await sleep(50);
  return editorMatches(h, text);
}

/** Attach files to a file input the way a user selection would. */
export function attachFiles(input: HTMLInputElement, files: File[]): void {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  try {
    input.files = dt.files;
  } catch {
    /* strict setter */
  }
  if ((input.files?.length ?? 0) !== files.length) Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function dataUrlToFile(name: string, type: string, dataUrl: string): File {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}
