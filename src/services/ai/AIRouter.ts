import { db } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { uid } from '@/lib/utils';
import type { AIModel, ProviderConfig, ProviderId, Settings } from '@/types/models';
import { CostGuard } from './CostGuard';
import { ModelRegistry, isPaid } from './ModelRegistry';
import { createProvider as defaultCreate } from './providers';
import type { AIProvider, ChatMessage } from './types';

export type RouterErrorCode = 'NO_ELIGIBLE' | 'ALL_FAILED' | 'COST_CAP';

export interface RouterAttempt {
  providerId: ProviderId;
  modelId?: string;
  outcome: 'skipped' | 'failed';
  reason: string;
}

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    public readonly attempts: RouterAttempt[],
  ) {
    super(RouterError.describe(code, attempts));
    this.name = 'RouterError';
  }
  static describe(code: RouterErrorCode, attempts: RouterAttempt[]): string {
    const head =
      code === 'COST_CAP'
        ? 'Daily AI cost cap reached'
        : code === 'NO_ELIGIBLE'
          ? 'No eligible AI provider/model for this request'
          : 'All AI providers failed';
    const detail = attempts.map((a) => `${a.providerId}${a.modelId ? `/${a.modelId}` : ''}: ${a.reason}`).join('; ');
    return detail ? `${head} — ${detail}` : head;
  }
}

export interface GenerateRequest {
  messages: ChatMessage[];
  needsVision?: boolean;
  purpose: 'interactive' | 'autopilot';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  providerId: ProviderId;
  modelId: string;
}

interface Deps {
  createProvider?: (id: ProviderId, cfg: ProviderConfig) => AIProvider;
}

export class AIRouter {
  private create: (id: ProviderId, cfg: ProviderConfig) => AIProvider;
  constructor(deps: Deps = {}) {
    this.create = deps.createProvider ?? defaultCreate;
  }

  private order(s: Settings, purpose: GenerateRequest['purpose']): ProviderId[] {
    if (purpose === 'autopilot' && s.autopilot.model) return [s.autopilot.model.providerId];
    switch (s.router.mode) {
      case 'manual':
        return s.router.manualProvider ? [s.router.manualProvider] : [];
      case 'offline':
        return ['ollama'];
      default:
        return s.router.priority;
    }
  }

  /** Picks the model for a provider, honouring vision and paid rules. Returns a skip reason when none fits. */
  private async pickModel(
    s: Settings,
    p: ProviderId,
    req: GenerateRequest,
    paidAllowed: boolean,
  ): Promise<{ model: string; info?: AIModel } | { skip: string }> {
    const preferred = req.purpose === 'autopilot' && s.autopilot.model?.providerId === p ? s.autopilot.model.modelId : s.providers[p].model;
    const freeOnly = s.router.mode === 'freeOnly';
    const ok = (id: string, info?: AIModel): string | null => {
      if (req.needsVision && info?.vision !== true) return 'model has no vision support';
      if (isPaid(p, info) && (freeOnly || !paidAllowed)) return freeOnly ? 'paid model blocked by Free-Only mode' : 'paid model not allowed';
      return id ? null : 'no model selected';
    };
    if (preferred) {
      const info = await ModelRegistry.get(p, preferred);
      const why = ok(preferred, info);
      if (!why) return { model: preferred, info };
      if (!req.needsVision || req.purpose === 'autopilot') return { skip: why };
    } else if (!req.needsVision) {
      return { skip: 'no model selected' };
    }
    // Vision fallback: first eligible vision model registered for this provider.
    const candidates = (await ModelRegistry.list(p)).filter((m) => m.vision);
    for (const c of candidates) if (!ok(c.id, c)) return { model: c.id, info: c };
    return { skip: 'no eligible vision model' };
  }

  async generate(req: GenerateRequest, onToken?: (t: string) => void): Promise<GenerateResult> {
    const s = await getSettings();
    const autopilot = req.purpose === 'autopilot';
    const paidAllowed = autopilot ? s.autopilot.allowPaid : s.router.allowPaid;
    const cap = autopilot ? s.autopilot.dailyCapUsd : s.router.dailyCapUsd;
    const attempts: RouterAttempt[] = [];
    let tried = false;
    let capHit = false;

    for (const p of this.order(s, req.purpose)) {
      const cfg = s.providers[p];
      if (s.router.mode === 'offline' && p !== 'ollama') continue;
      if (!cfg?.enabled) {
        attempts.push({ providerId: p, outcome: 'skipped', reason: 'provider disabled' });
        continue;
      }
      if (p !== 'ollama' && !cfg.apiKey) {
        attempts.push({ providerId: p, outcome: 'skipped', reason: 'API key missing' });
        continue;
      }
      const pick = await this.pickModel(s, p, req, paidAllowed);
      if ('skip' in pick) {
        attempts.push({ providerId: p, outcome: 'skipped', reason: pick.skip });
        continue;
      }
      if (isPaid(p, pick.info) && (await CostGuard.todaySpend(req.purpose, s.timezone)) >= cap) {
        capHit = true;
        attempts.push({ providerId: p, modelId: pick.model, outcome: 'skipped', reason: `daily cap $${cap} reached` });
        continue;
      }

      tried = true;
      const t0 = Date.now();
      try {
        const r = await this.create(p, cfg).chat(
          { model: pick.model, messages: req.messages, temperature: req.temperature, maxTokens: req.maxTokens, signal: req.signal },
          onToken,
        );
        const usage = r.usage ?? { in: 0, out: 0 };
        await CostGuard.record({
          id: uid(),
          at: Date.now(),
          providerId: p,
          modelId: pick.model,
          purpose: req.purpose,
          inTokens: usage.in,
          outTokens: usage.out,
          costUsd: CostGuard.estimate(pick.info ?? { providerId: p, isFree: false }, usage),
          ok: true,
          latencyMs: Date.now() - t0,
        });
        await db.providers.put({ ...((await db.providers.get(p)) ?? { id: p }), lastSuccessAt: Date.now(), lastError: undefined });
        return { text: r.text, providerId: p, modelId: pick.model };
      } catch (e) {
        if (req.signal?.aborted) throw e;
        const reason = (e as Error).message;
        attempts.push({ providerId: p, modelId: pick.model, outcome: 'failed', reason });
        await CostGuard.record({
          id: uid(),
          at: Date.now(),
          providerId: p,
          modelId: pick.model,
          purpose: req.purpose,
          inTokens: 0,
          outTokens: 0,
          costUsd: 0,
          ok: false,
          latencyMs: Date.now() - t0,
        });
        await db.providers.put({ ...((await db.providers.get(p)) ?? { id: p }), lastError: reason });
        if (s.router.mode === 'manual') break;
      }
    }
    throw new RouterError(tried ? 'ALL_FAILED' : capHit ? 'COST_CAP' : 'NO_ELIGIBLE', attempts);
  }
}

export const aiRouter = new AIRouter();
