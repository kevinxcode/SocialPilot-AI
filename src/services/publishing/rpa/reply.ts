import { canonicalThreadUrl } from '@/services/content/comments';
import { normalizeText } from '../fingerprint';
import { click, findBySelectors, waitFor } from './dom';
import { runPublish, type EngineOpts, type EngineResult } from './engine';
import { THREADS } from './selectors/threads';

export interface ReplyInput {
  targetUrl: string;
  targetText: string;
  text: string;
  dryRun: boolean;
}

function targetContainer(url: string): Element | undefined {
  return Array.from(document.querySelectorAll(THREADS.postContainer)).find((c) =>
    Array.from(c.querySelectorAll<HTMLAnchorElement>('a[href]')).some((a) => canonicalThreadUrl(a.href) === url),
  );
}

export async function runReply(input: ReplyInput, opts: EngineOpts = {}): Promise<EngineResult> {
  const target = canonicalThreadUrl(input.targetUrl);
  if (!target || canonicalThreadUrl(location.href) !== target) return { status: 'failed', reason: 'Reply target changed or is invalid' };
  if (findBySelectors(THREADS.loggedOut)) return { status: 'failed', reason: 'Threads login required' };
  const parent = await waitFor(() => targetContainer(target), opts.timeoutMs ?? 15_000, opts.pollMs);
  const expected = normalizeText(input.targetText);
  if (!parent || !expected || !normalizeText(parent.textContent ?? '').includes(expected)) {
    return { status: 'failed', reason: 'Original post could not be verified; reply skipped' };
  }
  if (findBySelectors(THREADS.composerDialog)) return { status: 'failed', reason: 'Unexpected open composer; reply skipped' };
  const button = findBySelectors([
    { css: 'button, [role="button"]', label: '^(reply|comment|balas|komentar)(\\s|$)' },
    { css: 'button, [role="button"]', text: '^(reply|balas)$' },
  ], parent);
  if (!button) return { status: 'failed', reason: 'Reply button not found on the selected post' };
  click(button);
  const dialog = await waitFor(() => findBySelectors(THREADS.composerDialog), opts.timeoutMs ?? 15_000, opts.pollMs);
  if (!dialog) return { status: 'failed', reason: 'Reply composer did not open' };
  const author = target.match(/\/@([^/]+)/)![1];
  if (!normalizeText(dialog.textContent ?? '').includes(author.toLowerCase())) {
    return { status: 'failed', reason: 'Reply composer target could not be confirmed' };
  }
  return runPublish({ ...THREADS, postButton: [
    { css: 'button, [role="button"]', text: '^(reply|balas|post|posting|kirim)$' },
  ] }, { text: input.text, files: [], dryRun: input.dryRun }, opts);
}

/** A match must belong to our account on this exact conversation, with its own permalink. */
export async function findReply(targetUrl: string, profileUrl: string, fp: string, opts: EngineOpts = {}): Promise<{ found: boolean; url?: string }> {
  const target = canonicalThreadUrl(targetUrl);
  if (!target || canonicalThreadUrl(location.href) !== target) throw new Error('Reply verification target changed');
  if (findBySelectors(THREADS.loggedOut)) throw new Error('Threads login required');
  const own = new URL(profileUrl).pathname.replace(/\/$/, '').toLowerCase();
  const hit = await waitFor(() => {
    for (const c of Array.from(document.querySelectorAll(THREADS.postContainer))) {
      const links = Array.from(c.querySelectorAll<HTMLAnchorElement>('a[href]'));
      const urls = links.map((a) => canonicalThreadUrl(a.href)).filter((u): u is string => !!u);
      // Never match a container wrapping both the parent and its replies.
      if (urls.includes(target) || !normalizeText(c.textContent ?? '').includes(fp)) continue;
      const url = urls.find((u) => new URL(u).pathname.toLowerCase().startsWith(`${own}/post/`));
      if (url) return url;
    }
    return null;
  }, opts.timeoutMs ?? 10_000, opts.pollMs);
  return hit ? { found: true, url: hit } : { found: false };
}
