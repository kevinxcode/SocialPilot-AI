import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { Badge, Card, CardTitle, Field, Input, Select, Switch } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { CONTENT_TYPES } from '@/services/content/prompts';
import { modelBadges } from './ProviderCard';
import type { Language, ProviderId } from '@/types/models';

export function AutopilotSettings() {
  const { settings, update } = useSettings();
  const models = useLiveQuery(() => db.models.toArray(), []) ?? [];
  const slots = useLiveQuery(() => db.queue.where('kind').equals('slot').sortBy('runAt'), []) ?? [];
  if (!settings) return null;
  const a = settings.autopilot;
  const set = (patch: Partial<typeof a>) => update({ autopilot: patch });
  const selected = a.model ? models.find((m) => m.providerId === a.model!.providerId && m.id === a.model!.modelId) : undefined;
  const eligible = models.filter((m) => a.allowPaid || m.providerId === 'ollama' || m.isFree);

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        Autopilot {a.enabled ? a.paused ? <Badge tone="warning">Paused</Badge> : <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
      </CardTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        Generates and publishes posts on its own from the brand knowledge base and saved ideas. Each slot writes separate text for each
        platform. Posts with prices/numbers not in the knowledge base are regenerated once, then skipped.
      </p>
      <div className="grid gap-4 md:grid-cols-4">
        <Field label="Enabled">
          <div className="flex h-9 items-center gap-3">
            <Switch checked={a.enabled} onChange={(v) => set({ enabled: v })} label="Enable autopilot" />
            {a.enabled && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={a.paused} onChange={(v) => set({ paused: v })} label="Pause autopilot" /> Pause
              </label>
            )}
          </div>
        </Field>
        <Field label="Platforms">
          <div className="flex h-9 items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={a.platforms.threads} onChange={(v) => set({ platforms: { ...a.platforms, threads: v } })} label="Threads" /> Threads
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={a.platforms.facebook} onChange={(v) => set({ platforms: { ...a.platforms, facebook: v } })} label="Facebook" />{' '}
              Facebook
            </label>
          </div>
        </Field>
        <Field label="Posts per day (per platform)">
          <Input type="number" min={1} max={6} value={a.postsPerDay} onChange={(e) => set({ postsPerDay: Math.min(6, Math.max(1, Number(e.target.value) || 1)) })} />
        </Field>
        <Field label="Language">
          <Select value={a.language} onChange={(e) => set({ language: e.target.value as Language })}>
            <option value="id">Indonesia</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Field label={`Window start (${settings.timezone})`}>
          <Input type="time" value={a.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
        </Field>
        <Field label="Window end">
          <Input type="time" value={a.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
        </Field>
        <Field label="Facebook after Threads (min)">
          <Input type="number" min={0} value={a.facebookOffsetMinutes} onChange={(e) => set({ facebookOffsetMinutes: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Attach images from library">
          <div className="flex h-9 items-center">
            <Switch checked={a.attachMedia} onChange={(v) => set({ attachMedia: v })} label="Attach media" />
          </div>
        </Field>
        <div className="md:col-span-2">
          <Field label="Autopilot model (free / local unless paid is allowed)">
            <Select
              value={a.model ? `${a.model.providerId}|${a.model.modelId}` : ''}
              onChange={(e) => {
                const [providerId, ...rest] = e.target.value.split('|');
                set({ model: e.target.value ? { providerId: providerId as ProviderId, modelId: rest.join('|') } : undefined });
              }}
            >
              <option value="">Use router priority (free/local only)</option>
              {eligible.map((m) => (
                <option key={`${m.providerId}|${m.id}`} value={`${m.providerId}|${m.id}`}>
                  {m.providerId}: {m.name}
                </option>
              ))}
            </Select>
            {selected && <div className="mt-1 flex gap-1">{modelBadges(selected)}</div>}
          </Field>
        </div>
        <Field label="Allow paid models for autopilot">
          <div className="flex h-9 items-center">
            <Switch checked={a.allowPaid} onChange={(v) => set({ allowPaid: v })} label="Allow paid for autopilot" />
          </div>
        </Field>
        <Field label="Autopilot daily cap (USD)">
          <Input type="number" min={0} step={0.1} disabled={!a.allowPaid} value={a.dailyCapUsd} onChange={(e) => set({ dailyCapUsd: Math.max(0, Number(e.target.value)) })} />
        </Field>
        <Field label="Review window (min, 0 = fully automatic)">
          <Input type="number" min={0} max={240} value={a.reviewWindowMinutes} onChange={(e) => set({ reviewWindowMinutes: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Content-type rotation</div>
        <div className="flex flex-wrap gap-1.5">
          {CONTENT_TYPES.map((c) => {
            const on = a.contentTypes.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => set({ contentTypes: on ? a.contentTypes.filter((x) => x !== c.id) : [...a.contentTypes, c.id] })}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
              >
                {c.en}
              </button>
            );
          })}
        </div>
      </div>
      {a.enabled && (
        <div className="mt-4 text-xs text-muted-foreground">
          Upcoming slots:{' '}
          {slots.length
            ? slots
                .slice(0, 8)
                .map((s) => `${s.platform === 'threads' ? 'Threads' : 'FB'} ${formatInTimeZone(s.runAt, settings.timezone, 'EEE HH:mm')}`)
                .join(' · ')
            : 'planned within a minute (Chrome must be open)'}
        </div>
      )}
    </Card>
  );
}
