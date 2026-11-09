/* Live provider check. Usage:
 *   OPENROUTER_API_KEY=... NVIDIA_API_KEY=... OLLAMA_HOST=http://localhost:11434 npx tsx scripts/check-providers.ts
 * Keys are read from env only and never printed. */
import { createProvider } from '../src/services/ai/providers';
import type { ProviderConfig, ProviderId } from '../src/types/models';

const configs: [ProviderId, ProviderConfig | null][] = [
  ['ollama', { enabled: true, baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434', timeoutMs: 180_000 }],
  ['openrouter', process.env.OPENROUTER_API_KEY ? { enabled: true, apiKey: process.env.OPENROUTER_API_KEY, baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 60_000 } : null],
  ['nvidia', process.env.NVIDIA_API_KEY ? { enabled: true, apiKey: process.env.NVIDIA_API_KEY, baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 60_000 } : null],
];

for (const [id, cfg] of configs) {
  if (!cfg) {
    console.warn(`${id}: SKIP (no key in env) — not verified`);
    continue;
  }
  const p = createProvider(id, cfg);
  const r = await p.test();
  let detail = '';
  if (r.ok) {
    const models = await p.listModels();
    detail = ` free=${models.filter((m) => m.isFree).length} vision=${models.filter((m) => m.vision).length}`;
  }
  console.warn(`${id}: ${r.ok ? 'OK' : 'FAIL'} ${r.message} (${r.latencyMs} ms)${detail}`);
}
