import { canonicalThreadUrl, parseCommentDecision } from '@/services/content/comments';
import { findBySelectors } from '@/services/publishing/rpa/dom';
import { runReply, findReply } from '@/services/publishing/rpa/reply';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

test('crawler only accepts canonical Threads post URLs', () => {
  expect(canonicalThreadUrl('https://www.threads.net/@owner/post/abc?x=1')).toBe('https://www.threads.com/@owner/post/abc');
  for (const url of ['https://evil.com/@owner/post/abc', 'javascript:alert(1)', 'https://threads.com.evil.com/@x/post/a']) {
    expect(canonicalThreadUrl(url)).toBeNull();
  }
});

test('AI comments require explicit high relevance and plain non-promotional text', () => {
  expect(parseCommentDecision('{"relevant":true,"confidence":0.95,"comment":"Pisahkan catatan setiap pelanggan agar mudah dicek."}')).toBeTruthy();
  for (const text of ['bad json', '{"relevant":false,"confidence":1,"comment":"Halo"}', '{"relevant":true,"confidence":0.2,"comment":"Halo"}', '{"relevant":true,"confidence":1,"comment":"Beli https://example.com"}']) {
    expect(parseCommentDecision(text)).toBeNull();
  }
});

test('RPA ignores buttons hidden by an ancestor', () => {
  document.body.innerHTML = '<div style="display:none"><button>Reply</button></div><button id="visible">Reply</button>';
  expect(findBySelectors([{ css: 'button', text: '^Reply$' }])?.id).toBe('visible');
});

test('reply refuses a redirected target before touching the composer', async () => {
  document.body.innerHTML = '<button>Reply</button>';
  const clicked = vi.fn();
  document.querySelector('button')!.addEventListener('click', clicked);
  const result = await runReply({ targetUrl: 'https://www.threads.com/@other/post/abc', targetText: 'original', text: 'Helpful reply', dryRun: false }, { timeoutMs: 1, pollMs: 1, delay: false });
  expect(result.status).toBe('failed');
  expect(clicked).not.toHaveBeenCalled();
});

test('a verified target opens its reply composer and dry run never sends', async () => {
  const target = 'https://www.threads.com/@owner/post/abc';
  vi.stubGlobal('location', { href: target, pathname: '/@owner/post/abc' });
  document.body.innerHTML = '<div data-pressable-container="true"><a href="https://www.threads.com/@owner/post/abc">Owner</a><p>Bagaimana mengatur cucian pelanggan?</p><button aria-label="Reply">Reply</button></div>';
  const send = vi.fn();
  document.querySelector('button')!.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Reply to owner<div contenteditable="true" role="textbox"></div><button id="send">Reply</button></div>');
    document.getElementById('send')!.addEventListener('click', send);
  });
  const result = await runReply({ targetUrl: target, targetText: 'Bagaimana mengatur cucian pelanggan?', text: 'Pisahkan catatan untuk setiap pelanggan.', dryRun: true }, { timeoutMs: 30, pollMs: 1, delay: false });
  expect(result.status).toBe('dry-run');
  expect(document.querySelector('[contenteditable]')?.textContent).toBe('Pisahkan catatan untuk setiap pelanggan.');
  expect(send).not.toHaveBeenCalled();
});

test('reply verification rejects identical text by another author', async () => {
  const target = 'https://www.threads.com/@owner/post/abc';
  vi.stubGlobal('location', { href: target });
  document.body.innerHTML = '<div data-pressable-container="true"><a href="https://www.threads.com/@other/post/r">other</a><p>useful reply</p></div>';
  expect(await findReply(target, 'https://www.threads.com/@me', 'useful reply', { timeoutMs: 1, pollMs: 1 })).toEqual({ found: false });
  document.querySelector('a')!.href = 'https://www.threads.com/@me/post/r';
  expect(await findReply(target, 'https://www.threads.com/@me', 'useful reply', { timeoutMs: 1, pollMs: 1 })).toEqual({ found: true, url: 'https://www.threads.com/@me/post/r' });
});
