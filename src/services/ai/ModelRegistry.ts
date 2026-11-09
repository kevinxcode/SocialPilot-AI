import { db } from '@/services/storage/db';
import { getSettings, updateSettings } from '@/services/storage/settings';
import type { AIModel, ProviderId } from '@/types/models';
import { createProvider } from './providers';

export const ModelRegistry = {
  /** Fetches the live model list from the provider and replaces the cached list. */
  async refresh(providerId: ProviderId): Promise<AIModel[]> {
    const s = await getSettings();
    const models = await createProvider(providerId, s.providers[providerId]).listModels();
    await db.transaction('rw', db.models, async () => {
      await db.models.where('providerId').equals(providerId).delete();
      await db.models.bulkPut(models.map((m) => ({ ...m, key: `${providerId}:${m.id}` })));
    });
    const current = s.providers[providerId].model;
    if (!current || !models.some((m) => m.id === current)) {
      const def = pickDefaultModel(providerId, models);
      if (def) await updateSettings({ providers: { [providerId]: { model: def } } });
    }
    return models;
  },

  async get(providerId: ProviderId, modelId: string): Promise<AIModel | undefined> {
    return db.models.get(`${providerId}:${modelId}`);
  },

  async list(providerId: ProviderId): Promise<AIModel[]> {
    return db.models.where('providerId').equals(providerId).sortBy('name');
  },
};

/** Ollama is always free; others are free only when the registry says so. Unknown → paid (safe default). */
export function isPaid(providerId: ProviderId, model: AIModel | undefined): boolean {
  if (providerId === 'ollama') return false;
  return !(model?.isFree === true);
}

const OLLAMA_PREFERRED = [/^qwen3:8b$/, /^qwen3:/, /^qwen2\.5:/, /^llama3/, /^gemma/];

/** Sensible default chat model after a successful connection; never picks a paid model for OpenRouter. */
export function pickDefaultModel(providerId: ProviderId, models: AIModel[]): string | undefined {
  if (!models.length) return undefined;
  if (providerId === 'openrouter') {
    return models.find((m) => m.id === 'openrouter/free')?.id ?? models.find((m) => m.isFree)?.id;
  }
  if (providerId === 'ollama') {
    const text = models.filter((m) => !m.vision);
    for (const re of OLLAMA_PREFERRED) {
      const hit = text.find((m) => re.test(m.id));
      if (hit) return hit.id;
    }
    return (text[0] ?? models[0]).id;
  }
  return (models.find((m) => /instruct/i.test(m.id)) ?? models[0]).id;
}
