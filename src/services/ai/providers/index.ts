import type { ProviderConfig, ProviderId } from '@/types/models';
import type { AIProvider } from '../types';
import { NvidiaProvider } from './NvidiaProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';

export function createProvider(id: ProviderId, cfg: ProviderConfig): AIProvider {
  switch (id) {
    case 'ollama':
      return new OllamaProvider(cfg);
    case 'nvidia':
      return new NvidiaProvider(cfg);
    case 'openrouter':
      return new OpenRouterProvider(cfg);
  }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (local)',
  nvidia: 'NVIDIA API Catalog',
  openrouter: 'OpenRouter',
};
