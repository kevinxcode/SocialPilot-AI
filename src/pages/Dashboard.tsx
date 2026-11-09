import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Empty, Switch } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { platformLabel } from '@/lib/platform';
import { computeStats } from '@/services/analytics/stats';
import { CostGuard } from '@/services/ai/CostGuard';
import type { PageId } from '@/layouts/Sidebar';
import { StatTile } from './Analytics';
import { StatusBadge } from './PostEditor';

export function DashboardPage({ navigate }: { navigate: (p: PageId) => void }) {
  const { settings, update } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const posts = useLiveQuery(() => db.posts.toArray(), []) ?? [];
  const logs = useLiveQuery(() => db.logs.orderBy('at').reverse().limit(12).toArray(), []) ?? [];
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) ?? [];
  const slots = useLiveQuery(() => db.queue.where('kind').equals('slot').sortBy('runAt'), []) ?? [];
  const spend = useLiveQuery(() => CostGuard.todaySpend(undefined, tz), [tz]);
  const now = Date.now();
  const s = computeStats(posts, { from: now - 7 * 86_400_000, to: now }, tz);
  const upcoming = posts
    .filter((p) => ['scheduled', 'processing', 'verifying'].includes(p.status))
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
    .slice(0, 6);
  const needsAttention = posts.filter((p) => p.status === 'failed' && p.updatedAt > now - 2 * 86_400_000).length;
  const ap = settings?.autopilot;

  return (
    <div className="space-y-4">
      {accounts.length < 2 && (
        <Card className="flex items-center justify-between border-amber-500/40 bg-amber-500/5 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Set up your Threads account and Facebook Page to start publishing.
          </span>
          <Button size="sm" variant="outline" onClick={() => navigate('accounts')}>
            Social Accounts
          </Button>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Scheduled" value={s.scheduled} />
        <StatTile label="Published (7 days)" value={s.published} />
        <StatTile label="Failed (7 days)" value={s.failed} hint={needsAttention ? `${needsAttention} need attention` : undefined} />
        <StatTile label="Success rate" value={s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`} />
        <StatTile label="AI spend today" value={`$${(spend ?? 0).toFixed(3)}`} hint="Ollama: Rp0 (hardware not incl.)" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>Upcoming</CardTitle>
          {upcoming.length === 0 ? (
            <Empty>No scheduled posts.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {upcoming.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">
                    {p.scheduledAt ? formatInTimeZone(p.scheduledAt, tz, 'EEE dd MMM HH:mm') : '—'}
                  </span>
                  <span className="w-16 shrink-0 text-xs">{platformLabel(p.platform)}</span>
                  <span className="min-w-0 flex-1 truncate">{p.text}</span>
                  <StatusBadge post={p} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => navigate('studio')}>
              <Sparkles className="h-4 w-4" /> Generate content
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('calendar')}>
              Calendar
            </Button>
          </div>
        </Card>
        <Card>
          <CardTitle className="flex items-center justify-between">
            Autopilot
            {ap?.enabled ? ap.paused ? <Badge tone="warning">Paused</Badge> : <Badge tone="success">Running</Badge> : <Badge>Off</Badge>}
          </CardTitle>
          {ap?.enabled ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={!ap.paused} onChange={(v) => update({ autopilot: { paused: !v } })} label="Autopilot running" />
                {ap.paused ? 'Resume' : 'Running'} — {ap.postsPerDay}/day
              </label>
              <div className="mt-2 text-xs text-muted-foreground">
                Next slots:{' '}
                {slots.length
                  ? slots
                      .slice(0, 4)
                      .map((q) => `${q.platform === 'threads' ? 'Threads' : 'FB'} ${formatInTimeZone(q.runAt, tz, 'EEE HH:mm')}`)
                      .join(' · ')
                  : '—'}
              </div>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => navigate('settings')}>
              Configure autopilot
            </Button>
          )}
          <CardTitle className="mt-4">Engagement</CardTitle>
          <p className="text-sm text-muted-foreground">N/A — not collected (no engagement data is scraped or estimated).</p>
        </Card>
      </div>
      <Card>
        <CardTitle>Activity</CardTitle>
        {logs.length === 0 ? (
          <Empty>No activity yet.</Empty>
        ) : (
          <ul className="space-y-1 text-xs">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-2">
                <span className="w-32 shrink-0 text-muted-foreground">{formatInTimeZone(l.at, tz, 'dd MMM HH:mm:ss')}</span>
                <Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'default'}>{l.scope}</Badge>
                <span className="min-w-0 flex-1 break-words">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
