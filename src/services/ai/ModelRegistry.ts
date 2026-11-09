import { db } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
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
