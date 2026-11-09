import type { Settings } from '@/types/models';

const KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  language: 'id',
  theme: 'system',
  timezone: 'Asia/Jakarta',
  minGapMinutes: 60,
  groupGapMinutes: 30,
  autoPickMedia: true,
  router: {
    mode: 'auto',
    priority: ['ollama', 'nvidia', 'openrouter'],
    allowPaid: false,
    dailyCapUsd: 1,
  },
  providers: {
    ollama: { enabled: true, baseUrl: 'http://localhost:11434', timeoutMs: 180_000, model: 'qwen3:8b' },
    nvidia: { enabled: false, baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 60_000 },
    openrouter: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 60_000, model: 'openrouter/free' },
  },
  autopilot: {
    enabled: false,
    paused: false,
    platforms: { threads: true, facebook: true, fbgroup: false },
    postsPerDay: 2,
    windowStart: '09:00',
    windowEnd: '19:00',
    contentTypes: ['educational', 'tips', 'pain-point', 'soft-selling'],
    language: 'id',
    attachMedia: true,
    allowPaid: false,
    dailyCapUsd: 0.5,
    facebookOffsetMinutes: 30,
    reviewWindowMinutes: 0,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = merge(b, v as DeepPartial<typeof b>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY);
  return merge(DEFAULT_SETTINGS, r[KEY] as DeepPartial<Settings> | undefined);
}

export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const next = merge(await getSettings(), patch);
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export type { DeepPartial };
