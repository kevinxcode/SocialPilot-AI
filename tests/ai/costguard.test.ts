import { CostGuard } from '@/services/ai/CostGuard';
import { db, resetDb } from '@/services/storage/db';
import type { AIModel } from '@/types/models';

beforeEach(resetDb);

const m = (p: Partial<AIModel>): AIModel => ({ id: 'x', providerId: 'openrouter', name: 'x', isFree: false, vision: false, ...p });

test('Ollama cost is 0', () => {
  expect(CostGuard.estimate(m({ providerId: 'ollama', isFree: true }), { in: 5000, out: 5000 })).toBe(0);
});

test('priced model cost uses per-million pricing', () => {
  expect(CostGuard.estimate(m({ pricing: { inPerM: 2, outPerM: 4 } }), { in: 500_000, out: 250_000 })).toBeCloseTo(2);
});

test('free model costs 0, unpriced paid model is null (unknown)', () => {
  expect(CostGuard.estimate(m({ isFree: true }), { in: 1, out: 1 })).toBe(0);
  expect(CostGuard.estimate(m({ providerId: 'nvidia' }), { in: 1, out: 1 })).toBeNull();
});

test('todaySpend sums only today and the given purpose', async () => {
  const base = { providerId: 'openrouter' as const, modelId: 'm', inTokens: 0, outTokens: 0, ok: true, latencyMs: 1 };
  await CostGuard.record({ ...base, id: '1', at: Date.now(), purpose: 'autopilot', costUsd: 0.2 });
  await CostGuard.record({ ...base, id: '2', at: Date.now(), purpose: 'interactive', costUsd: 0.5 });
  await CostGuard.record({ ...base, id: '3', at: Date.now() - 3 * 86400_000, purpose: 'autopilot', costUsd: 9 });
  expect(await CostGuard.todaySpend('autopilot')).toBeCloseTo(0.2);
  const s = await CostGuard.summary({ from: 0, to: Date.now() + 1 });
  expect(s.openrouter.calls).toBe(3);
  expect(s.openrouter.costUsd).toBeCloseTo(9.7);
  expect(await db.aiUsage.count()).toBe(3);
});
