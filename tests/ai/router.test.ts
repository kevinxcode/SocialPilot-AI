import { AIRouter, RouterError } from '@/services/ai/AIRouter';
import { db, resetDb } from '@/services/storage/db';
import { updateSettings } from '@/services/storage/settings';
import type { AIProvider } from '@/services/ai/types';
import type { AIModel, ProviderId } from '@/types/models';

type Behaviour = 'ok' | 'fail';
let behaviour: Record<ProviderId, Behaviour>;
let calls: { provider: ProviderId; model: string }[];

function fakeFactory(id: ProviderId): AIProvider {
  return {
    id,
    listModels: async () => [],
    test: async () => ({ ok: true, message: '', latencyMs: 0 }),
    chat: async (req) => {
      calls.push({ provider: id, model: req.model });
      if (behaviour[id] === 'fail') throw new Error(`${id} down`);
      return { text: `from ${id}`, usage: { in: 1000, out: 1000 } };
    },
  };
}

const model = (providerId: ProviderId, id: string, isFree: boolean, vision = false, pricing?: AIModel['pricing']): AIModel => ({
  key: `${providerId}:${id}`, providerId, id, name: id, isFree, vision, pricing,
});

const router = new AIRouter({ createProvider: (id) => fakeFactory(id) });
const msgs = [{ role: 'user' as const, content: 'hi' }];

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  behaviour = { ollama: 'ok', nvidia: 'ok', openrouter: 'ok' };
  calls = [];
  await db.models.bulkPut([
    model('ollama', 'qwen3:8b', true),
    model('ollama', 'qwen3-vl:8b', true, true),
    model('nvidia', 'meta/llama', false, false, { inPerM: 1, outPerM: 1 }),
    model('openrouter', 'free/model', true),
    model('openrouter', 'paid/model', false, true, { inPerM: 100, outPerM: 100 }),
  ]);
  await updateSettings({
    providers: {
      ollama: { enabled: true, model: 'qwen3:8b' },
      nvidia: { enabled: true, apiKey: 'k', model: 'meta/llama' },
      openrouter: { enabled: true, apiKey: 'k', model: 'free/model' },
    },
    router: { mode: 'auto', allowPaid: true, dailyCapUsd: 1 },
  });
});

test('falls back to next provider on failure and records usage', async () => {
  behaviour.ollama = 'fail';
  const r = await router.generate({ messages: msgs, purpose: 'interactive' });
  expect(r.providerId).toBe('nvidia');
  expect(calls.map((c) => c.provider)).toEqual(['ollama', 'nvidia']);
  expect(await db.aiUsage.count()).toBe(2);
});

test('freeOnly never calls a paid model', async () => {
  await updateSettings({ router: { mode: 'freeOnly' } });
  behaviour.ollama = 'fail';
  const r = await router.generate({ messages: msgs, purpose: 'interactive' });
  expect(r.providerId).toBe('openrouter');
  expect(calls.map((c) => c.provider)).toEqual(['ollama', 'openrouter']);
});

test('freeOnly with only paid available → NO_ELIGIBLE and no request', async () => {
  await updateSettings({ router: { mode: 'freeOnly' }, providers: { ollama: { enabled: false }, openrouter: { model: 'paid/model' } } });
  await expect(router.generate({ messages: msgs, purpose: 'interactive' })).rejects.toMatchObject({ code: 'NO_ELIGIBLE' });
  expect(calls).toEqual([]);
});

test('offline uses only Ollama', async () => {
  await updateSettings({ router: { mode: 'offline' } });
  behaviour.ollama = 'fail';
  await expect(router.generate({ messages: msgs, purpose: 'interactive' })).rejects.toBeInstanceOf(RouterError);
  expect(calls.map((c) => c.provider)).toEqual(['ollama']);
});

test('vision request skips text-only models and picks a vision model of an eligible provider', async () => {
  const r = await router.generate({ messages: msgs, purpose: 'interactive', needsVision: true });
  expect(r).toMatchObject({ providerId: 'ollama', modelId: 'qwen3-vl:8b' });
  expect(calls).toEqual([{ provider: 'ollama', model: 'qwen3-vl:8b' }]);
});

test('vision request in freeOnly with only a paid vision model → NO_ELIGIBLE', async () => {
  await updateSettings({ router: { mode: 'freeOnly' }, providers: { ollama: { enabled: false } } });
  await expect(router.generate({ messages: msgs, purpose: 'interactive', needsVision: true })).rejects.toMatchObject({ code: 'NO_ELIGIBLE' });
  expect(calls).toEqual([]);
});

test('manual mode uses only the selected provider (no fallback)', async () => {
  await updateSettings({ router: { mode: 'manual', manualProvider: 'nvidia' } });
  behaviour.nvidia = 'fail';
  await expect(router.generate({ messages: msgs, purpose: 'interactive' })).rejects.toMatchObject({ code: 'ALL_FAILED' });
  expect(calls.map((c) => c.provider)).toEqual(['nvidia']);
});

test('autopilot with paid model and allowPaid=false → NO_ELIGIBLE', async () => {
  await updateSettings({ autopilot: { model: { providerId: 'openrouter', modelId: 'paid/model' }, allowPaid: false } });
  await expect(router.generate({ messages: msgs, purpose: 'autopilot' })).rejects.toMatchObject({ code: 'NO_ELIGIBLE' });
  expect(calls).toEqual([]);
});

test('daily cap exceeded → COST_CAP', async () => {
  await updateSettings({ router: { mode: 'manual', manualProvider: 'openrouter', dailyCapUsd: 0.1 }, providers: { openrouter: { model: 'paid/model' } } });
  await db.aiUsage.add({ id: 'u', at: Date.now(), providerId: 'openrouter', modelId: 'paid/model', purpose: 'interactive', inTokens: 0, outTokens: 0, costUsd: 0.5, ok: true, latencyMs: 1 });
  await expect(router.generate({ messages: msgs, purpose: 'interactive' })).rejects.toMatchObject({ code: 'COST_CAP' });
  expect(calls).toEqual([]);
});

test('disabled provider is never called', async () => {
  await updateSettings({ providers: { ollama: { enabled: false } } });
  await router.generate({ messages: msgs, purpose: 'interactive' });
  expect(calls.map((c) => c.provider)).toEqual(['nvidia']);
});

test('paid model in auto mode requires allowPaid', async () => {
  await updateSettings({ router: { allowPaid: false }, providers: { ollama: { enabled: false } } });
  const r = await router.generate({ messages: msgs, purpose: 'interactive' });
  expect(r.providerId).toBe('openrouter');
  expect(calls.map((c) => c.provider)).toEqual(['openrouter']);
});

test('model with no registry entry on a paid provider is treated as paid', async () => {
  await updateSettings({ router: { mode: 'freeOnly' }, providers: { ollama: { enabled: false }, openrouter: { model: 'unknown/x' } } });
  await expect(router.generate({ messages: msgs, purpose: 'interactive' })).rejects.toMatchObject({ code: 'NO_ELIGIBLE' });
});
