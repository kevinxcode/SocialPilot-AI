import { OpenRouterProvider } from '@/services/ai/providers/OpenRouterProvider';
import { OllamaProvider } from '@/services/ai/providers/OllamaProvider';
import { NvidiaProvider } from '@/services/ai/providers/NvidiaProvider';
import { fetchWithTimeout } from '@/services/ai/http';

const enc = new TextEncoder();
function streamResponse(chunks: string[], init: ResponseInit = { status: 200 }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, init);
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

test('OpenRouter parses free and vision flags', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    json({
      data: [
        { id: 'a/free', name: 'A', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, context_length: 8000 },
        { id: 'b/paid', name: 'B', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'] } },
      ],
    }),
  ));
  const models = await new OpenRouterProvider({ enabled: true, apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 1000 }).listModels();
  expect(models[0]).toMatchObject({ id: 'a/free', isFree: true, vision: true, providerId: 'openrouter' });
  expect(models[1]).toMatchObject({ id: 'b/paid', isFree: false, vision: false, pricing: { inPerM: 1, outPerM: 2 } });
});

test('OpenRouter SSE stream accumulates tokens', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    streamResponse([
      'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n',
      ': keepalive\n\ndata: {"choices":[{"delta":{"content":"o 🧺"}}]}\n',
      '\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ]),
  ));
  const toks: string[] = [];
  const r = await new OpenRouterProvider({ enabled: true, apiKey: 'k', baseUrl: 'https://x', timeoutMs: 1000 }).chat(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    (t) => toks.push(t),
  );
  expect(r.text).toBe('Halo 🧺');
  expect(toks).toEqual(['Hal', 'o 🧺']);
  expect(r.usage).toEqual({ in: 3, out: 2 });
});

test('Ollama lists models with vision capability and streams NDJSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'llava:7b' }, { name: 'qwen2.5:7b' }] });
    if (url.endsWith('/api/show')) {
      const name = JSON.parse(String(init?.body)).model;
      return json({ capabilities: name.startsWith('llava') ? ['completion', 'vision'] : ['completion'] });
    }
    return streamResponse(['{"message":{"content":"Ha"},"done":false}\n{"message":{"content":"lo"},', '"done":false}\n{"done":true,"prompt_eval_count":4,"eval_count":2}\n']);
  }));
  const p = new OllamaProvider({ enabled: true, baseUrl: 'http://localhost:11434', timeoutMs: 1000 });
  const models = await p.listModels();
  expect(models.find((m) => m.id === 'llava:7b')).toMatchObject({ vision: true, isFree: true });
  expect(models.find((m) => m.id === 'qwen2.5:7b')?.vision).toBe(false);
  const r = await p.chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'x' }] });
  expect(r.text).toBe('Halo');
  expect(r.usage).toEqual({ in: 4, out: 2 });
});

test('Ollama error mapping: not running, CORS 403, model missing', async () => {
  const p = new OllamaProvider({ enabled: true, baseUrl: 'http://localhost:11434', timeoutMs: 1000 });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(p.chat({ model: 'm', messages: [] })).rejects.toThrow(/Ollama not running/);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
  await expect(p.chat({ model: 'm', messages: [] })).rejects.toThrow(/OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: "model 'llama9' not found" }, 404)));
  await expect(p.chat({ model: 'llama9', messages: [] })).rejects.toThrow(/ollama pull llama9/);
});

test('NVIDIA models are labelled credits (not free)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'nvidia/vila' }] })));
  const models = await new NvidiaProvider({ enabled: true, apiKey: 'k', baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 1000 }).listModels();
  expect(models.every((m) => !m.isFree)).toBe(true);
  expect(models[0].providerId).toBe('nvidia');
});

test('fetchWithTimeout aborts', async () => {
  vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => {
    init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  })));
  await expect(fetchWithTimeout('http://x', {}, 20)).rejects.toThrow(/timed out/);
});

test('API key never appears in thrown errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'bad key sk-secret-123' } }, 401)));
  const p = new OpenRouterProvider({ enabled: true, apiKey: 'sk-secret-123', baseUrl: 'https://x', timeoutMs: 1000 });
  await expect(p.chat({ model: 'm', messages: [] })).rejects.toThrow(/401/);
  await expect(p.chat({ model: 'm', messages: [] })).rejects.not.toThrow(/sk-secret-123/);
});
