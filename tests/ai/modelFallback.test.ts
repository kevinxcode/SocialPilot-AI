import { AIRouter } from '@/services/ai/AIRouter';
import { ProviderError, type AIProvider } from '@/services/ai/types';
import { db, resetDb } from '@/services/storage/db';
import { updateSettings } from '@/services/storage/settings';
import type { AIModel } from '@/types/models';

const m = (id: string, isFree: boolean, pricing?: AIModel['pricing']): AIModel => ({ key: `openrouter:${id}`, providerId: 'openrouter', id, name: id, isFree, vision: false, pricing });

let tried: string[];
let busy: Set<string>;
const router = new AIRouter({
  createProvider: (id): AIProvider => ({
    id,
    listModels: async () => [],
    test: async () => ({ ok: true, message: '', latencyMs: 0 }),
    chat: async (req) => {
      tried.push(req.model);
      if (busy.has(req.model)) throw new ProviderError('openrouter error 429: rate-limited upstream', 429, true);
      return { text: `ok from ${req.model}` };
    },
  }),
});

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  tried = [];
  busy = new Set();
  await db.models.bulkPut([m('google/gemma:free', true), m('openrouter/free', true), m('x/other:free', true), m('a/paid', false, { inPerM: 1, outPerM: 1 })]);
  await updateSettings({
    router: { mode: 'auto', allowPaid: true, dailyCapUsd: 5 },
    providers: { ollama: { enabled: false }, openrouter: { enabled: true, apiKey: 'k', model: 'google/gemma:free' } },
  });
});

test('busy free model → switches to another free model of the same provider (openrouter/free first)', async () => {
  busy.add('google/gemma:free');
  const r = await router.generate({ messages: [{ role: 'user', content: 'hi' }], purpose: 'interactive' });
  expect(r.modelId).toBe('openrouter/free');
  expect(tried).toEqual(['google/gemma:free', 'openrouter/free']);
});

test('never switches to a paid model, even when paid is allowed', async () => {
  busy = new Set(['google/gemma:free', 'openrouter/free', 'x/other:free']);
  await expect(router.generate({ messages: [{ role: 'user', content: 'hi' }], purpose: 'interactive' })).rejects.toMatchObject({ code: 'ALL_FAILED' });
  expect(tried).not.toContain('a/paid');
  expect(tried.length).toBe(3);
});

test('non-retryable error (bad key) does not cycle through models', async () => {
  const r2 = new AIRouter({
    createProvider: (id): AIProvider => ({
      id,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '', latencyMs: 0 }),
      chat: async (req) => {
        tried.push(req.model);
        throw new ProviderError('openrouter HTTP 401 (check API key)', 401, false);
      },
    }),
  });
  await expect(r2.generate({ messages: [{ role: 'user', content: 'hi' }], purpose: 'interactive' })).rejects.toMatchObject({ code: 'ALL_FAILED' });
  expect(tried).toEqual(['google/gemma:free']);
});
