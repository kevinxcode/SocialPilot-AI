import type { ProviderConfig, ProviderId } from '@/types/models';
import { errorText, fetchWithTimeout, readLines, redact } from '../http';
import { ProviderError, type ChatRequest, type ChatResult } from '../types';

/** Shared OpenAI-compatible chat/completions SSE client (OpenRouter, NVIDIA). */
export async function openAiChat(
  providerId: ProviderId,
  cfg: ProviderConfig,
  req: ChatRequest,
  onToken?: (t: string) => void,
  extraHeaders: Record<string, string> = {},
  extraBody: Record<string, unknown> = {},
): Promise<ChatResult> {
  const messages = req.messages.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))],
        }
      : { role: m.role, content: m.content },
  );
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey ?? ''}`, ...extraHeaders },
        body: JSON.stringify({
          model: req.model,
          messages,
          temperature: req.temperature ?? 0.8,
          max_tokens: req.maxTokens ?? 2048,
          stream: true,
          stream_options: { include_usage: true },
          ...extraBody,
        }),
        signal: req.signal,
      },
      cfg.timeoutMs,
    );
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`${providerId}: network error`);
  }
  if (!res.ok) {
    const msg = redact(await errorText(res), cfg.apiKey);
    const hint = res.status === 401 ? ' (check API key)' : res.status === 429 ? ' (rate limited)' : '';
    throw new ProviderError(`${providerId} HTTP ${res.status}${hint}: ${msg}`, res.status, res.status === 429 || res.status >= 500);
  }
  let text = '';
  let usage: ChatResult['usage'];
  for await (const line of readLines(res)) {
    const l = line.trim();
    if (l.startsWith('{')) {
      // Some gateways answer HTTP 200 with a plain JSON error body instead of an SSE stream.
      let j: { error?: { message?: string; code?: number; metadata?: { raw?: string } } } | undefined;
      try {
        j = JSON.parse(l);
      } catch {
        /* not JSON */
      }
      if (j?.error) {
        const e = j.error;
        const code = e.code ?? 0;
        throw new ProviderError(
          `${providerId} error ${code}: ${redact(`${e.message ?? ''}${e.metadata?.raw ? ` — ${e.metadata.raw}` : ''}`, cfg.apiKey).slice(0, 300)}`,
          code || undefined,
          code === 429 || code >= 500,
        );
      }
      continue;
    }
    if (!l.startsWith('data:')) continue;
    const data = l.slice(5).trim();
    if (data === '[DONE]') break;
    try {
      const j = JSON.parse(data);
      if (j.error) throw new ProviderError(`${providerId}: ${redact(String(j.error.message ?? j.error), cfg.apiKey)}`);
      const tok = j.choices?.[0]?.delta?.content;
      if (typeof tok === 'string' && tok) {
        text += tok;
        onToken?.(tok);
      }
      if (j.usage) usage = { in: j.usage.prompt_tokens ?? 0, out: j.usage.completion_tokens ?? 0 };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
    }
  }
  if (!text.trim()) throw new ProviderError(`${providerId}: empty response`);
  return { text, usage };
}

export async function openAiModels(cfg: ProviderConfig, url: string, headers: Record<string, string> = {}): Promise<unknown[]> {
  const res = await fetchWithTimeout(url, { headers }, Math.min(cfg.timeoutMs, 30_000));
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${redact(await errorText(res), cfg.apiKey)}`, res.status);
  const j = await res.json();
  return Array.isArray(j?.data) ? j.data : [];
}
