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
        <Field label="Automatic Threads comments">
          <Switch checked={settings.comments.enabled} onChange={(enabled) => update({ comments: { enabled } })} label="Automatic comments without approval" />
          <p className="mt-1 text-xs text-muted-foreground">Searches enabled topics and replies to relevant posts during the autopilot window. No approval required. Results appear in the queue.</p>
        </Field>
        <Field label="Maximum comments per day">
          <Input type="number" min={0} max={10} value={settings.comments.dailyLimit} onChange={(e) => update({ comments: { dailyLimit: Math.max(0, Math.min(10, Number(e.target.value) || 0)) } })} />
        </Field>
        <Field label="Minimum comment gap (minutes)">
          <Input type="number" min={30} value={settings.comments.gapMinutes} onChange={(e) => update({ comments: { gapMinutes: Math.max(30, Number(e.target.value) || 60) } })} />
        </Field>
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
          <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={a.platforms.threads} onChange={(v) => set({ platforms: { ...a.platforms, threads: v } })} label="Threads" /> Threads
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={a.platforms.facebook} onChange={(v) => set({ platforms: { ...a.platforms, facebook: v } })} label="Facebook" />{' '}
              Facebook
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={a.platforms.fbgroup} onChange={(v) => set({ platforms: { ...a.platforms, fbgroup: v } })} label="Facebook Groups" /> FB Groups
            </label>
          </div>
        </Field>
        <Field label="Posts per day (Threads / Facebook Page)">
          <Input type="number" min={1} max={10} value={a.postsPerDay} onChange={(e) => set({ postsPerDay: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} />
        </Field>
        <Field label="FB Group posts per day (different groups)">
          <Input
            type="number"
            min={1}
            max={5}
            disabled={!a.platforms.fbgroup}
            value={a.groupPostsPerDay ?? 1}
            onChange={(e) => set({ groupPostsPerDay: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })}
          />
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
        <Field label="Threads: add website link with UTM (from Knowledge Base)">
          <div className="flex h-9 items-center">
            <Switch checked={a.ctaLink !== false} onChange={(v) => set({ ctaLink: v })} label="Add website link" />
          </div>
        </Field>
        <Field label="Learn from engagement (reads your Threads profile daily)">
          <div className="flex h-9 items-center">
            <Switch checked={a.learnFromEngagement !== false} onChange={(v) => set({ learnFromEngagement: v })} label="Learn from engagement" />
          </div>
        </Field>
        <Field label="Post at the best hours (learned from engagement)">
          <div className="flex h-9 items-center">
            <Switch checked={a.bestTimes !== false} onChange={(v) => set({ bestTimes: v })} label="Best hours" />
          </div>
        </Field>
        <Field label="Recycle top posts older than 30 days (new angle)">
          <div className="flex h-9 items-center">
            <Switch checked={a.recycle !== false} onChange={(v) => set({ recycle: v })} label="Recycle top posts" />
          </div>
        </Field>
        <Field label="AI picks the image that fits the text">
          <div className="flex h-9 items-center">
            <Switch checked={a.aiImagePick !== false} onChange={(v) => set({ aiImagePick: v })} label="AI image pick" />
          </div>
        </Field>
        <Field label="Daily summary notification (after the window ends)">
          <div className="flex h-9 items-center">
            <Switch checked={a.dailySummary !== false} onChange={(v) => set({ dailySummary: v })} label="Daily summary" />
          </div>
        </Field>
        <Field label="Reply to comments on our own Threads posts (per day)">
          <div className="flex h-9 items-center gap-2">
            <Switch checked={a.ownReplies !== false} onChange={(v) => set({ ownReplies: v })} label="Reply to comments" />
            <Input
              type="number"
              min={1}
              max={20}
              className="w-20"
              value={a.ownRepliesPerDay ?? 10}
              onChange={(e) => set({ ownRepliesPerDay: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
              aria-label="Replies per day"
            />
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
