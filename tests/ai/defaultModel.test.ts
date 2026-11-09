import { pickDefaultModel } from '@/services/ai/ModelRegistry';
import type { AIModel, ProviderId } from '@/types/models';

const m = (providerId: ProviderId, id: string, isFree = false, vision = false): AIModel => ({ providerId, id, name: id, isFree, vision });

test('OpenRouter prefers openrouter/free, then any free model, never a paid one', () => {
  expect(pickDefaultModel('openrouter', [m('openrouter', 'a/paid'), m('openrouter', 'x/y:free', true), m('openrouter', 'openrouter/free', true)])).toBe('openrouter/free');
  expect(pickDefaultModel('openrouter', [m('openrouter', 'a/paid'), m('openrouter', 'x/y:free', true)])).toBe('x/y:free');
  expect(pickDefaultModel('openrouter', [m('openrouter', 'a/paid')])).toBeUndefined();
});

test('Ollama prefers a text model of a known good family, else the first', () => {
  expect(pickDefaultModel('ollama', [m('ollama', 'qwen3-vl:8b', true, true), m('ollama', 'qwen3:8b', true), m('ollama', 'qwen3.6:35b', true)])).toBe('qwen3:8b');
  expect(pickDefaultModel('ollama', [m('ollama', 'mistral:7b', true)])).toBe('mistral:7b');
  expect(pickDefaultModel('ollama', [])).toBeUndefined();
});

test('NVIDIA picks an instruct model if available', () => {
  expect(pickDefaultModel('nvidia', [m('nvidia', 'nvidia/embed-qa'), m('nvidia', 'meta/llama-3.1-8b-instruct')])).toBe('meta/llama-3.1-8b-instruct');
});

test('refresh selects a default model when none is set, and keeps an existing valid choice', async () => {
  const { ModelRegistry } = await import('@/services/ai/ModelRegistry');
  const { getSettings, updateSettings } = await import('@/services/storage/settings');
  const { resetDb } = await import('@/services/storage/db');
  await resetDb();
  await chrome.storage.local.clear();
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.endsWith('/models') ? json({ data: [{ id: 'a/paid', pricing: { prompt: '1', completion: '1' } }, { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } }] }) : json({}),
  ));
  await updateSettings({ providers: { openrouter: { enabled: true, apiKey: 'k' } } });
  await ModelRegistry.refresh('openrouter');
  expect((await getSettings()).providers.openrouter.model).toBe('openrouter/free');
  await updateSettings({ providers: { openrouter: { model: 'a/paid' } } });
  await ModelRegistry.refresh('openrouter');
  expect((await getSettings()).providers.openrouter.model).toBe('a/paid');
  vi.unstubAllGlobals();
});
