import { ProviderError } from './types';

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal;
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new ProviderError(`Request timed out after ${Math.round(ms / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** Reads a streaming body line by line (handles chunks that split lines). */
export async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) {
    const text = await res.text();
    for (const l of text.split('\n')) yield l;
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

/** Remove any occurrence of secrets from a message before surfacing it. */
export function redact(msg: string, ...secrets: (string | undefined)[]): string {
  let out = msg;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/(sk-|nvapi-)[A-Za-z0-9_-]{6,}/g, '$1***');
}

export async function errorText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      return String(j?.error?.message ?? j?.error ?? j?.message ?? t).slice(0, 300);
    } catch {
      return t.slice(0, 300);
    }
  } catch {
    return '';
  }
}
