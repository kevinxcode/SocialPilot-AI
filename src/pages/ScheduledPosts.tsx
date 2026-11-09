import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { Empty, Select, Table, Tabs } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { platformLabel } from '@/lib/platform';
import type { Platform, Post, PostStatus } from '@/types/models';
import { PostEditor, StatusBadge } from './PostEditor';

type View = 'queue' | 'drafts' | 'history';

export function ScheduledPostsPage({ initialView = 'queue' }: { initialView?: View }) {
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [view, setView] = useState<View>(initialView);
  const [platform, setPlatform] = useState<'' | Platform>('');
  const [status, setStatus] = useState<'' | PostStatus>('');
  const [open, setOpen] = useState<Post | null>(null);
  const posts = useLiveQuery(() => db.posts.toArray(), []) ?? [];

  const inView = (p: Post) =>
    view === 'drafts'
      ? p.status === 'draft'
      : view === 'queue'
        ? ['scheduled', 'processing', 'verifying'].includes(p.status)
        : ['published', 'failed', 'cancelled'].includes(p.status);
  const list = posts
    .filter((p) => inView(p) && (!platform || p.platform === platform) && (!status || p.status === status))
    .sort((a, b) =>
      view === 'queue' ? (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) : (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt),
    );
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
        <div className="flex gap-2">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as '' | Platform)} aria-label="Platform filter">
            <option value="">All platforms</option>
            <option value="threads">Threads</option>
            <option value="facebook">Facebook Page</option>
            <option value="fbgroup">Facebook Group</option>
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value as '' | PostStatus)} aria-label="Status filter">
            <option value="">All statuses</option>
            {(['draft', 'scheduled', 'processing', 'verifying', 'published', 'failed', 'cancelled'] as const).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
      </div>
      {list.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{view === 'history' ? 'When' : 'Scheduled'}</th>
              <th>Platform</th>
              <th>Post</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setOpen(p)}>
                <td className="whitespace-nowrap">{fmt(view === 'history' ? (p.publishedAt ?? p.updatedAt) : p.scheduledAt)}</td>
                <td>{platformLabel(p.platform)}{p.replyTo ? ' · Reply' : ''}</td>
                <td className="max-w-md truncate">{p.text}</td>
                <td>
                  <StatusBadge post={p} />
                </td>
                <td className="max-w-xs truncate text-xs text-muted-foreground">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>
                      open post
                    </a>
                  ) : (
                    (p.error ?? p.note ?? (p.nextRetryAt ? `retry ${fmt(p.nextRetryAt)}` : ''))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PostEditor post={open} onClose={() => setOpen(null)} />
    </div>
  );
}
