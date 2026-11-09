import type { AIModel, ProviderConfig } from '@/types/models';
import { errorText, fetchWithTimeout, readLines } from '../http';
import { ProviderError, type AIProvider, type ChatRequest, type ChatResult, type TestResult } from '../types';

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama' as const;
  constructor(private cfg: ProviderConfig) {}

  private base() {
    return this.cfg.baseUrl.replace(/\/$/, '');
  }

  private async call(path: string, init: RequestInit, ms: number, model?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.base()}${path}`, init, ms);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`Ollama not running at ${this.base()} — start it with "ollama serve"`);
    }
    if (res.status === 403) {
      throw new ProviderError(
        'Ollama rejected the extension origin (403). Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.',
        403,
        false,
      );
    }
    if (res.status === 404 && model) {
      throw new ProviderError(`Ollama model not installed: run "ollama pull ${model}"`, 404, false);
    }
    if (!res.ok) throw new ProviderError(`Ollama HTTP ${res.status}: ${await errorText(res)}`, res.status);
    return res;
  }

  async listModels(): Promise<AIModel[]> {
    const res = await this.call('/api/tags', {}, 15_000);
    const j = (await res.json()) as { models?: { name: string; details?: { families?: string[] } }[] };
    const list = j.models ?? [];
    return Promise.all(
      list.map(async (m) => {
        let vision = (m.details?.families ?? []).includes('clip');
        try {
          const s = await this.call('/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }) }, 15_000);
          const info = (await s.json()) as { capabilities?: string[] };
          if (info.capabilities) vision = info.capabilities.includes('vision');
        } catch {
          /* keep heuristic */
        }
        return { key: `ollama:${m.name}`, id: m.name, providerId: 'ollama' as const, name: m.name, isFree: true, vision };
      }),
    );
  }

  async test(): Promise<TestResult> {
    const t0 = Date.now();
    try {
      const models = await this.listModels();
      if (!models.length) return { ok: false, message: 'Ollama running but no models installed (ollama pull qwen2.5:7b)', latencyMs: Date.now() - t0 };
      if (this.cfg.model && !models.some((m) => m.id === this.cfg.model)) {
        return { ok: false, message: `Model not installed: run "ollama pull ${this.cfg.model}"`, latencyMs: Date.now() - t0 };
      }
      return { ok: true, message: `${models.length} local models`, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: (e as Error).message, latencyMs: Date.now() - t0 };
    }
  }

  async chat(req: ChatRequest, onToken?: (t: string) => void): Promise<ChatResult> {
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images.map((d) => d.replace(/^data:[^;]+;base64,/, '')) } : {}),
    }));
    const res = await this.call(
      '/api/chat',
      {
        method: 'POST',
        body: JSON.stringify({
          model: req.model,
          messages,
          stream: true,
          options: { temperature: req.temperature ?? 0.8, num_predict: req.maxTokens ?? 2048 },
        }),
        signal: req.signal,
      },
      this.cfg.timeoutMs,
      req.model,
    );
    let text = '';
    let usage: ChatResult['usage'];
    for await (const line of readLines(res)) {
      if (!line.trim()) continue;
      let j: { message?: { content?: string }; done?: boolean; error?: string; prompt_eval_count?: number; eval_count?: number };
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new ProviderError(`Ollama: ${j.error}`);
      const tok = j.message?.content;
      if (tok) {
        text += tok;
        onToken?.(tok);
      }
      if (j.done) usage = { in: j.prompt_eval_count ?? 0, out: j.eval_count ?? 0 };
    }
    if (!text.trim()) throw new ProviderError('Ollama: empty response');
    return { text, usage };
  }
}
