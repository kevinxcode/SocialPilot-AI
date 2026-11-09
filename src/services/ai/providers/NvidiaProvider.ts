import type { AIModel, ProviderConfig } from '@/types/models';
import type { AIProvider, ChatRequest, ChatResult, TestResult } from '../types';
import { openAiChat, openAiModels } from './openaiCompat';

const VISION_HINT = /(vision|vila|vlm|llava|neva|kosmos|fuyu|paligemma|phi-3.*vision|llama-3\.2-\d+b-vision|nemotron.*vl)/i;

/** NVIDIA API Catalog (integrate.api.nvidia.com). Paid unless the user marks the account as free developer tier. */
export class NvidiaProvider implements AIProvider {
  readonly id = 'nvidia' as const;
  constructor(private cfg: ProviderConfig) {}

  async listModels(): Promise<AIModel[]> {
    const data = (await openAiModels(this.cfg, `${this.cfg.baseUrl.replace(/\/$/, '')}/models`, {
      authorization: `Bearer ${this.cfg.apiKey ?? ''}`,
    })) as { id: string }[];
    return data.map((m) => ({
      key: `nvidia:${m.id}`,
      id: m.id,
      providerId: 'nvidia',
      name: m.id,
      isFree: !!this.cfg.freeTier,
      vision: VISION_HINT.test(m.id),
    }));
  }

  async test(): Promise<TestResult> {
    const t0 = Date.now();
    if (!this.cfg.apiKey) return { ok: false, message: 'API key missing', latencyMs: 0 };
    try {
      const models = await this.listModels();
      if (this.cfg.model) await this.chat({ model: this.cfg.model, messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 5 });
      return { ok: true, message: `${models.length} models (credit-based)`, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: (e as Error).message, latencyMs: Date.now() - t0 };
    }
  }

  chat(req: ChatRequest, onToken?: (t: string) => void): Promise<ChatResult> {
    return openAiChat('nvidia', this.cfg, req, onToken);
  }
}
