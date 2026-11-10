import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { Button, Empty, Select, Table, Tabs, useToast } from '@/components/ui';
import { CheckCircle2, ListOrdered, Loader2, Pause, Play, X } from 'lucide-react';
import { autoReorder, cancel, markPublishedByUser, setPaused } from '@/services/publishing/PublishingQueue';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { platformLabel } from '@/lib/platform';
import type { Platform, Post, PostStatus } from '@/types/models';
import { PostEditor, StatusBadge, isOnHold, postDetail } from './PostEditor';

/**
 * Queue order: what is happening now first, then what will really be published (earliest first), then what waits:
 * being published → being checked → scheduled → paused / held.
 */
export function queueRank(p: Post, autopilotHeld = false): number {
  if (p.status === 'processing') return 0;
  if (p.status === 'verifying') return 1;
  return isOnHold(p, autopilotHeld) ? 3 : 2;
}

type View = 'queue' | 'drafts' | 'history';

/** `lockPlatform`: show only that platform's posts (used by the Instagram page); the platform filter is hidden. */
export function ScheduledPostsPage({ initialView = 'queue', lockPlatform }: { initialView?: View; lockPlatform?: Platform }) {
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [view, setView] = useState<View>(initialView);
  const [platformFilter, setPlatform] = useState<'' | Platform>('');
  const platform = lockPlatform ?? platformFilter;
  const [status, setStatus] = useState<'' | PostStatus>('');
  const [open, setOpen] = useState<Post | null>(null);
  const posts = useLiveQuery(() => db.posts.toArray(), []) ?? [];
  const apHeld = !!settings && (!settings.autopilot.enabled || settings.autopilot.paused);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const inView = (p: Post) =>
    view === 'drafts'
      ? p.status === 'draft'
      : view === 'queue'
        ? ['scheduled', 'processing', 'verifying'].includes(p.status)
        : ['published', 'failed', 'cancelled'].includes(p.status);
  const list = posts
    .filter((p) => inView(p) && (!platform || p.platform === platform) && (!status || p.status === status))
    .sort((a, b) =>
      view === 'queue'
        ? queueRank(a, apHeld) - queueRank(b, apHeld) || (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)
        : (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt),
    );
  // Infinite scroll: render 30 rows, load 30 more when the sentinel scrolls into view.
  const [limit, setLimit] = useState(30);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLimit(30);
    setSelected(new Set());
  }, [view, platform, status]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && setLimit((l) => l + 30), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.length, limit]);
  // Bulk actions (Queue only). Posts being published right now cannot be changed and are skipped.
  // 'verifying' may be selected too (Cancel / Mark as published); only a post being published right now may not.
  const selectable = (p: Post) => view === 'queue' && (p.status === 'scheduled' || p.status === 'verifying');
  const shown = list.slice(0, limit);
  const chosen = list.filter((p) => selected.has(p.id) && selectable(p));
  const allShownSelected = shown.some(selectable) && shown.filter(selectable).every((p) => selected.has(p.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.filter(selectable).map((p) => p.id)));
  const bulk = async (action: 'pause' | 'resume' | 'cancel' | 'published') => {
    const ids = chosen.map((p) => p.id);
    if (!ids.length) return;
    if (action === 'cancel' && !confirm(`Cancel ${ids.length} post(s)? They will not be published (posts already live stay live).`)) return;
    if (action === 'published' && !confirm(`Mark ${ids.length} post(s) as published? Only do this when you have seen them live.`)) return;
    setBusy(true);
    try {
      let n = 0;
      if (action === 'cancel') {
        for (const id of ids) {
          try {
            await cancel(id);
            n++;
          } catch {
            /* being published right now — skipped */
          }
        }
      } else if (action === 'published') n = await markPublishedByUser(ids);
      else n = await setPaused(ids, action === 'pause');
      toast(`${n} post(s) ${action === 'cancel' ? 'cancelled' : action === 'published' ? 'marked as published' : action === 'pause' ? 'paused' : 'resumed'}${n < ids.length ? ` · ${ids.length - n} skipped` : ''}`);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };
  const fmt = (ms?: number) => (ms ? formatInTimeZone(ms, tz, 'dd MMM yyyy HH:mm') : '—');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { value: 'queue', label: 'Queue' },
            { value: 'drafts', label: 'Drafts' },
            { value: 'history', label: 'History' },
          ]}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {view === 'queue' && (
            <Button
              variant="outline"
              className="h-9"
              disabled={busy}
              title="Spread the waiting posts of each platform at the gap set in Settings, starting from now. Paused posts are not touched."
              onClick={async () => {
                if (!confirm('Re-order the queue? Waiting posts are spread out at the minimum gap per platform, starting from now. Paused posts are not changed.')) return;
                setBusy(true);
                try {
                  const n = await autoReorder();
                  toast(n ? `${n} post(s) re-scheduled` : 'The queue is already in order');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListOrdered className="h-4 w-4" />} Auto re-order
            </Button>
          )}
          {!lockPlatform && (
          <Select className="w-44" value={platform} onChange={(e) => setPlatform(e.target.value as '' | Platform)} aria-label="Platform filter">
            <option value="">All platforms</option>
            <option value="threads">Threads</option>
            <option value="facebook">Facebook Page</option>
            <option value="fbgroup">Facebook Group</option>
            <option value="instagram">Instagram</option>
          </Select>
          )}
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value as '' | PostStatus)} aria-label="Status filter">
            <option value="">All statuses</option>
            {(['draft', 'scheduled', 'processing', 'verifying', 'published', 'failed', 'cancelled'] as const).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
      </div>
      {view === 'queue' && chosen.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-2 text-sm">
          <span className="px-1 font-medium">{chosen.length} selected</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk('pause')}>
            <Pause className="h-3.5 w-3.5" /> Pause
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk('resume')}>
            <Play className="h-3.5 w-3.5" /> Resume
          </Button>
          {chosen.some((p) => p.status === 'verifying') && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk('published')} title="You have seen it live: stop checking and move it to History">
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark as published
            </Button>
          )}
          <Button size="sm" variant="outline" className="text-red-500" disabled={busy} onClick={() => bulk('cancel')}>
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
          <button type="button" className="ml-auto px-1 text-xs text-muted-foreground underline" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      {list.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              {view === 'queue' && (
                <th className="w-8">
                  <input type="checkbox" aria-label="Select all" checked={allShownSelected} onChange={toggleAll} className="h-4 w-4 cursor-pointer accent-primary" />
                </th>
              )}
              <th>{view === 'history' ? 'When' : 'Scheduled'}</th>
              <th>Platform</th>
              <th>Post</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className={`cursor-pointer hover:bg-muted/50 ${selected.has(p.id) ? 'bg-primary/5' : ''} ${isOnHold(p, apHeld) ? '[&>td:not(:first-child)]:opacity-60' : ''}`} onClick={() => setOpen(p)}>
                {view === 'queue' && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select post ${p.text.slice(0, 30)}`}
                      disabled={!selectable(p)}
                      title={selectable(p) ? undefined : 'Being published right now'}
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                  </td>
                )}
                <td className="whitespace-nowrap">{fmt(view === 'history' ? (p.publishedAt ?? p.updatedAt) : p.scheduledAt)}</td>
                <td className="whitespace-nowrap">{platformLabel(p.platform)}{p.replyTo ? ' · Reply' : ''}</td>
                <td className="max-w-md truncate">{p.text}</td>
                <td>
                  <span className="whitespace-nowrap">
                    <StatusBadge post={p} autopilotHeld={apHeld} />
                  </span>
                </td>
                <td className="max-w-xs text-xs text-muted-foreground">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>
                      open post
                    </a>
                  ) : null}
                  {p.engagement != null && (
                    <span className="ml-2" title="Likes + replies + reposts, read from your Threads profile">
                      ♥ {p.engagement}
                    </span>
                  )}
                  {!p.url &&
                    (() => {
                      const d = postDetail(p, fmt, apHeld);
                      return (
                        <span className={`line-clamp-2 ${d.tone === 'error' ? 'text-red-500' : d.tone === 'warn' ? 'text-amber-500' : ''}`} title={d.text}>
                          {d.text}
                        </span>
                      );
                    })()}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.length > 0 && list.length <= limit && (
        <div className="py-3 text-center text-xs text-muted-foreground">All {list.length} posts shown</div>
      )}
      {list.length > limit && (
        <div ref={sentinel} className="py-4 text-center text-xs text-muted-foreground">
          Showing {limit} of {list.length} — scroll for more
        </div>
      )}
      <PostEditor post={open} onClose={() => setOpen(null)} />
    </div>
  );
}
