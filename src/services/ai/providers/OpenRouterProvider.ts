import type { AIModel, ProviderConfig } from '@/types/models';
import type { AIProvider, ChatRequest, ChatResult, TestResult } from '../types';
import type { ProviderError } from '../types';
import { openAiChat, openAiModels } from './openaiCompat';

interface ORModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; modality?: string };
}

const HEADERS = { 'HTTP-Referer': 'https://cuciqu.com/', 'X-Title': 'SocialPilot AI' };

export class OpenRouterProvider implements AIProvider {
  readonly id = 'openrouter' as const;
  constructor(private cfg: ProviderConfig) {}

  async listModels(): Promise<AIModel[]> {
    const data = (await openAiModels(this.cfg, `${this.base()}/models`)) as ORModel[];
    return data.map((m) => {
      const pin = Number(m.pricing?.prompt ?? NaN);
      const pout = Number(m.pricing?.completion ?? NaN);
      const priced = Number.isFinite(pin) && Number.isFinite(pout);
      return {
        key: `openrouter:${m.id}`,
        id: m.id,
        providerId: 'openrouter',
        name: m.name ?? m.id,
        isFree: priced && pin === 0 && pout === 0,
        vision: (m.architecture?.input_modalities ?? []).includes('image') || /image/.test(m.architecture?.modality ?? ''),
        contextLength: m.context_length,
        pricing: priced ? { inPerM: +(pin * 1e6).toFixed(6), outPerM: +(pout * 1e6).toFixed(6) } : undefined,
      };
    });
  }

  async test(): Promise<TestResult> {
    const t0 = Date.now();
    if (!this.cfg.apiKey) return { ok: false, message: 'API key missing', latencyMs: 0 };
    try {
      const models = await this.listModels();
      if (this.cfg.model) {
        try {
          await this.chat({ model: this.cfg.model, messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 16 });
        } catch (e) {
          const err = e as ProviderError;
          if (err.status === 429 || /429|rate.?limit/i.test(err.message)) {
            return {
              ok: true,
              message: `Key OK, ${models.length} models — but "${this.cfg.model}" is busy upstream (rate limited). Try again later or pick another free model; the router falls back automatically.`,
              latencyMs: Date.now() - t0,
            };
          }
          if (/empty response/i.test(err.message)) {
            return { ok: true, message: `Key OK, ${models.length} models (test reply was empty — model may need more tokens)`, latencyMs: Date.now() - t0 };
          }
          throw e;
        }
      }
      return { ok: true, message: `${models.length} models available`, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: (e as Error).message, latencyMs: Date.now() - t0 };
    }
  }

  chat(req: ChatRequest, onToken?: (t: string) => void): Promise<ChatResult> {
    return openAiChat('openrouter', this.cfg, req, onToken, HEADERS, { reasoning: { exclude: true } });
  }

  private base() {
    return this.cfg.baseUrl.replace(/\/$/, '');
  }
}
