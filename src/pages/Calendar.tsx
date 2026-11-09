import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Empty, Select, Tabs, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { schedulePost } from '@/services/publishing/PublishingQueue';
import { cn } from '@/lib/utils';
import type { Platform, Post, PostStatus } from '@/types/models';
import { PostEditor, STATUS_TONE } from './PostEditor';

type View = 'month' | 'week' | 'day' | 'list';
const toneClass: Record<string, string> = {
  default: 'bg-muted',
  info: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  warning: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  success: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

/** Moves a post to another day in the user's timezone, keeping its time of day. */
export function moveToDay(scheduledAt: number, dayKey: string, tz: string): Date {
  const time = formatInTimeZone(scheduledAt, tz, 'HH:mm');
  return fromZonedTime(`${dayKey}T${time}`, tz);
}

export function CalendarPage() {
  const { settings } = useSettings();
  const toast = useToast();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => toZonedTime(Date.now(), tz));
  const [platform, setPlatform] = useState<'' | Platform>('');
  const [status, setStatus] = useState<'' | PostStatus>('');
  const [open, setOpen] = useState<Post | null>(null);
  const posts = useLiveQuery(() => db.posts.toArray(), []) ?? [];

  const dated = posts
    .filter((p) => (p.scheduledAt || p.publishedAt) && (!platform || p.platform === platform) && (!status || p.status === status))
    .map((p) => ({ p, at: p.publishedAt ?? p.scheduledAt! }))
    .sort((a, b) => a.at - b.at);
  const byDay = useMemo(() => {
    const m = new Map<string, { p: Post; at: number }[]>();
    for (const d of dated) {
      const k = formatInTimeZone(d.at, tz, 'yyyy-MM-dd');
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return m;
  }, [dated, tz]);

  const days: Date[] = [];
  if (view === 'month') {
    for (let d = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }); d <= endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }); d = addDays(d, 1)) days.push(d);
  } else if (view === 'week') {
    for (let i = 0, d = startOfWeek(cursor, { weekStartsOn: 1 }); i < 7; i++) days.push(addDays(d, i));
  } else if (view === 'day') days.push(cursor);

  const shift = (dir: 1 | -1) =>
    setCursor((c) => (view === 'month' ? addMonths(c, dir) : addDays(c, view === 'week' ? 7 * dir : dir)));

  const onDrop = async (dayKey: string, postId: string) => {
    const p = posts.find((x) => x.id === postId);
    if (!p?.scheduledAt || !['scheduled', 'draft', 'failed'].includes(p.status)) return toast('Only scheduled posts can be moved', 'err');
    const at = moveToDay(p.scheduledAt, dayKey, tz);
    if (at.getTime() < Date.now()) return toast('Cannot move into the past', 'err');
    await schedulePost(p.id, at);
    toast(`Moved to ${dayKey}`);
  };

  const chip = ({ p, at }: { p: Post; at: number }) => (
    <button
      key={p.id}
      type="button"
      draggable={p.status === 'scheduled'}
      onDragStart={(e) => e.dataTransfer.setData('text/post-id', p.id)}
      onClick={() => setOpen(p)}
      className={cn('block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px]', toneClass[STATUS_TONE[p.status]])}
      title={p.text}
    >
      {formatInTimeZone(at, tz, 'HH:mm')} {p.platform === 'threads' ? '@' : 'f'} {p.source === 'autopilot' ? '⚡' : ''}
      {p.text.slice(0, 40)}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(toZonedTime(Date.now(), tz))}>
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 font-semibold">{format(cursor, view === 'day' ? 'EEEE d MMM yyyy' : 'MMMM yyyy')}</span>
          <span className="text-xs text-muted-foreground">({tz})</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as '' | Platform)} aria-label="Platform filter">
            <option value="">All platforms</option>
            <option value="threads">Threads</option>
            <option value="facebook">Facebook</option>
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value as '' | PostStatus)} aria-label="Status filter">
            <option value="">All statuses</option>
            {(['scheduled', 'processing', 'verifying', 'published', 'failed', 'cancelled'] as const).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
              { value: 'day', label: 'Day' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
      </div>

      {view === 'list' ? (
        dated.length === 0 ? (
          <Empty>No scheduled or published posts.</Empty>
        ) : (
          <div className="space-y-1">
            {dated.map((d) => (
              <div key={d.p.id} className="flex items-center gap-3">
                <span className="w-36 shrink-0 text-xs text-muted-foreground">{formatInTimeZone(d.at, tz, 'EEE dd MMM HH:mm')}</span>
                {chip(d)}
              </div>
            ))}
          </div>
        )
      ) : (
        <div className={cn('grid gap-px overflow-hidden rounded-lg border border-border bg-border', view === 'day' ? 'grid-cols-1' : 'grid-cols-7')}>
          {(view === 'day' ? [] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).map((d) => (
            <div key={d} className="bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              {d}
            </div>
          ))}
          {days.map((d) => {
            const key = format(d, 'yyyy-MM-dd');
            const items = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('text/post-id');
                  if (id) void onDrop(key, id);
                }}
                className={cn(
                  'space-y-0.5 bg-background p-1',
                  view === 'month' ? 'min-h-24' : 'min-h-64',
                  view === 'month' && !isSameMonth(d, cursor) && 'opacity-50',
                )}
              >
                <div className={cn('text-right text-[11px] text-muted-foreground', key === formatInTimeZone(Date.now(), tz, 'yyyy-MM-dd') && 'font-bold text-primary')}>
                  {format(d, 'd')}
                </div>
                {items.map(chip)}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Drag a scheduled post to another day to reschedule it (time of day is kept).</p>
      <PostEditor post={open} onClose={() => setOpen(null)} />
    </div>
  );
}
