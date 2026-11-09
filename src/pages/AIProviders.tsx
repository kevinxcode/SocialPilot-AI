import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input, Select, Switch } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { createProvider, PROVIDER_LABELS } from '@/services/ai/providers';
import { ModelRegistry } from '@/services/ai/ModelRegistry';
import { CostGuard, OLLAMA_COST_NOTE, USD_TO_IDR, startOfTodayMs } from '@/services/ai/CostGuard';
import type { ProviderConfig, ProviderId, RouterMode } from '@/types/models';
import { ProviderCard } from './ProviderCard';

const IDS: ProviderId[] = ['ollama', 'nvidia', 'openrouter'];

async function ensureHostPermission(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const pattern = `${u.protocol}//${u.hostname}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export function AIProvidersPage() {
  const { settings, update } = useSettings();
  const statuses = useLiveQuery(() => db.providers.toArray(), []) ?? [];
  const models = useLiveQuery(() => db.models.toArray(), []) ?? [];
  const usage = useLiveQuery(() => CostGuard.summary({ from: startOfTodayMs(settings?.timezone), to: Date.now() + 60_000 }), [settings?.timezone]);
  if (!settings) return null;

  const setProvider = (id: ProviderId, patch: Partial<ProviderConfig>) => update({ providers: { [id]: patch } });
  const move = (i: number, d: -1 | 1) => {
    const pr = [...settings.router.priority];
    const j = i + d;
    if (j < 0 || j >= pr.length) return;
    [pr[i], pr[j]] = [pr[j], pr[i]];
    update({ router: { priority: pr } });
  };

  const test = async (id: ProviderId) => {
    const cfg = (await import('@/services/storage/settings').then((m) => m.getSettings())).providers[id];
    if (id === 'ollama' && !(await ensureHostPermission(cfg.baseUrl))) {
      return { ok: false, message: 'Host permission denied for this Ollama host', latencyMs: 0 };
    }
    const r = await createProvider(id, cfg).test();
    await db.providers.put({
      ...((await db.providers.get(id)) ?? { id }),
      lastTestOk: r.ok,
      lastTestMessage: r.message,
      lastLatencyMs: r.latencyMs,
      ...(r.ok ? { lastSuccessAt: Date.now() } : { lastError: r.message }),
    });
    if (r.ok) await ModelRegistry.refresh(id).catch(() => undefined);
    return r;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Smart Router</CardTitle>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Mode">
            <Select value={settings.router.mode} onChange={(e) => update({ router: { mode: e.target.value as RouterMode } })}>
              <option value="auto">Auto (priority + fallback)</option>
              <option value="manual">Manual (one provider, no fallback)</option>
              <option value="freeOnly">Free-Only</option>
              <option value="offline">Offline (Ollama only)</option>
            </Select>
          </Field>
          {settings.router.mode === 'manual' && (
            <Field label="Manual provider">
              <Select
                value={settings.router.manualProvider ?? ''}
                onChange={(e) => update({ router: { manualProvider: (e.target.value || undefined) as ProviderId | undefined } })}
              >
                <option value="">— select —</option>
                {IDS.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Allow paid models (interactive)">
            <div className="flex h-9 items-center">
              <Switch checked={settings.router.allowPaid} onChange={(v) => update({ router: { allowPaid: v } })} label="Allow paid models" />
            </div>
          </Field>
          <Field label="Daily cost cap (USD)">
            <Input
              type="number"
              min={0}
              step={0.1}
              value={settings.router.dailyCapUsd}
              onChange={(e) => update({ router: { dailyCapUsd: Math.max(0, Number(e.target.value)) } })}
            />
          </Field>
        </div>
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Priority (Auto / Free-Only)</div>
          <ol className="flex flex-wrap gap-2">
            {settings.router.priority.map((id, i) => (
              <li key={id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm">
                <span className="text-muted-foreground">{i + 1}.</span> {PROVIDER_LABELS[id]}
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(i, -1)} aria-label={`Move ${id} up`}>
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(i, 1)} aria-label={`Move ${id} down`}>
                  <ArrowDown className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ol>
        </div>
      </Card>

      {IDS.map((id) => (
        <ProviderCard
          key={id}
          id={id}
          label={PROVIDER_LABELS[id]}
          cfg={settings.providers[id]}
          status={statuses.find((s) => s.id === id)}
          models={models.filter((m) => m.providerId === id).sort((a, b) => a.name.localeCompare(b.name))}
          onChange={(patch) => setProvider(id, patch)}
          onTest={() => test(id)}
          onRefresh={async () => {
            if (id === 'ollama' && !(await ensureHostPermission(settings.providers.ollama.baseUrl))) throw new Error('Host permission denied');
            await ModelRegistry.refresh(id);
          }}
        />
      ))}

      <Card>
        <CardTitle>Cost Guard — today</CardTitle>
        <div className="grid gap-2 text-sm md:grid-cols-3">
          {IDS.map((id) => {
            const u = usage?.[id];
            return (
              <div key={id} className="rounded-md bg-muted p-3">
                <div className="font-medium">{PROVIDER_LABELS[id]}</div>
                <div className="text-muted-foreground">
                  {u?.calls ?? 0} calls · {(u?.inTokens ?? 0) + (u?.outTokens ?? 0)} tokens
                </div>
                <div>
                  {id === 'ollama'
                    ? OLLAMA_COST_NOTE
                    : `$${(u?.costUsd ?? 0).toFixed(4)} ≈ Rp${Math.round((u?.costUsd ?? 0) * USD_TO_IDR).toLocaleString('id-ID')}`}
                  {u?.unknownCostCalls ? ` (+${u.unknownCostCalls} calls with unknown price)` : ''}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
