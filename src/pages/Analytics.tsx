import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Card, CardTitle, Select, Table } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { computeStats, type Stats } from '@/services/analytics/stats';
import { CostGuard, OLLAMA_COST_NOTE, USD_TO_IDR } from '@/services/ai/CostGuard';
import { PROVIDER_LABELS } from '@/services/ai/providers';
import { contentTypeLabel } from '@/services/content/prompts';
import type { ProviderId } from '@/types/models';

export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

/** Single-series bar chart: posts published per day. Hover shows exact counts. */
export function PublishedPerDay({ days }: { days: Stats['byDay'] }) {
  const max = Math.max(1, ...days.map((d) => d.published));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <figure>
      <div className="relative flex h-40 items-end gap-[2px] border-b border-border" role="img" aria-label="Posts published per day">
        {days.map((d, i) => (
          <div
            key={d.day}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className={`w-full rounded-t-[4px] ${hover === i ? 'bg-primary' : 'bg-primary/75'}`}
              style={{ height: d.published ? `${(d.published / max) * 100}%` : 0 }}
            />
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 text-xs shadow">
            {days[hover].day}: {days[hover].published} published · {days[hover].failed} failed
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{days[0]?.day}</span>
        <span>max {max}/day</span>
        <span>{days[days.length - 1]?.day}</span>
      </figcaption>
    </figure>
  );
}

export function AnalyticsPage() {
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [days, setDays] = useState(30);
  const posts = useLiveQuery(() => db.posts.toArray(), []) ?? [];
  const now = Date.now();
  const range = { from: now - days * 86_400_000, to: now };
  const s = computeStats(posts, range, tz);
  const usage = useLiveQuery(() => CostGuard.summary(range), [days]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          From SocialPilot&apos;s own records. Engagement (likes, replies, reach) is <strong>N/A</strong> — it is not collected.
        </p>
        <Select className="w-40" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Published" value={s.published} />
        <StatTile label="Failed" value={s.failed} />
        <StatTile label="Success rate" value={s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`} />
        <StatTile label="By autopilot" value={s.autopilot} />
        <StatTile label="Engagement" value="N/A" hint="not collected" />
      </div>
      <Card>
        <CardTitle>Published per day</CardTitle>
        <PublishedPerDay days={s.byDay} />
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Per platform</CardTitle>
          <Table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Published</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {(['threads', 'facebook'] as const).map((p) => (
                <tr key={p}>
                  <td>{p === 'threads' ? 'Threads' : 'Facebook Page'}</td>
                  <td className="tabular-nums">{s.perPlatform[p].published}</td>
                  <td className="tabular-nums">{s.perPlatform[p].failed}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <CardTitle className="mt-4">By content type</CardTitle>
          <Table>
            <tbody>
              {Object.entries(s.byContentType)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{contentTypeLabel(k)}</td>
                    <td className="tabular-nums">{v}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle>AI usage & cost</CardTitle>
          <Table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Calls</th>
                <th>Failed</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(['ollama', 'nvidia', 'openrouter'] as ProviderId[]).map((id) => {
                const u = usage?.[id];
                return (
                  <tr key={id}>
                    <td>{PROVIDER_LABELS[id]}</td>
                    <td className="tabular-nums">{u?.calls ?? 0}</td>
                    <td className="tabular-nums">{u?.failures ?? 0}</td>
                    <td className="tabular-nums">{((u?.inTokens ?? 0) + (u?.outTokens ?? 0)).toLocaleString()}</td>
                    <td className="text-xs">
                      {id === 'ollama'
                        ? OLLAMA_COST_NOTE
                        : `$${(u?.costUsd ?? 0).toFixed(4)} ≈ Rp${Math.round((u?.costUsd ?? 0) * USD_TO_IDR).toLocaleString('id-ID')}${u?.unknownCostCalls ? ` (+${u.unknownCostCalls} unpriced)` : ''}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
