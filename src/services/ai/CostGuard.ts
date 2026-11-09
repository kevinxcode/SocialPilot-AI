import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { startOfDay } from 'date-fns';
import { db } from '@/services/storage/db';
import type { AIModel, AIUsage, ProviderId } from '@/types/models';

export const OLLAMA_COST_NOTE = 'Rp0 — local hardware/electricity not included';
export const USD_TO_IDR = 16_000; // display estimate only

export interface UsageSummaryRow {
  calls: number;
  failures: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  unknownCostCalls: number;
}

export function startOfTodayMs(timezone = 'Asia/Jakarta', now = Date.now()): number {
  return fromZonedTime(startOfDay(toZonedTime(now, timezone)), timezone).getTime();
}

export const CostGuard = {
  /** USD cost, 0 for local/free, null when the price is unknown. */
  estimate(model: Pick<AIModel, 'providerId' | 'isFree' | 'pricing'>, usage: { in: number; out: number }): number | null {
    if (model.providerId === 'ollama' || model.isFree) return 0;
    if (!model.pricing) return null;
    return (usage.in * model.pricing.inPerM + usage.out * model.pricing.outPerM) / 1e6;
  },

  async record(u: AIUsage): Promise<void> {
    await db.aiUsage.put(u);
  },

  async todaySpend(purpose?: AIUsage['purpose'], timezone = 'Asia/Jakarta'): Promise<number> {
    const rows = await db.aiUsage.where('at').aboveOrEqual(startOfTodayMs(timezone)).toArray();
    return rows.filter((r) => !purpose || r.purpose === purpose).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  },

  async summary(range: { from: number; to: number }): Promise<Record<ProviderId, UsageSummaryRow>> {
    const empty = (): UsageSummaryRow => ({ calls: 0, failures: 0, inTokens: 0, outTokens: 0, costUsd: 0, unknownCostCalls: 0 });
    const out: Record<ProviderId, UsageSummaryRow> = { ollama: empty(), nvidia: empty(), openrouter: empty() };
    const rows = await db.aiUsage.where('at').between(range.from, range.to, true, false).toArray();
    for (const r of rows) {
      const s = out[r.providerId];
      s.calls++;
      if (!r.ok) s.failures++;
      s.inTokens += r.inTokens;
      s.outTokens += r.outTokens;
      if (r.costUsd == null) s.unknownCostCalls++;
      else s.costUsd += r.costUsd;
    }
    return out;
  },
};
