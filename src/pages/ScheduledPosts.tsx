import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { Badge, Button, Empty, Select, Table, Tabs, useToast } from '@/components/ui';
import { CheckCircle2, LayoutGrid, MessageCircle, List, ListOrdered, Loader2, Pause, Play, Send, X } from 'lucide-react';
import { sendToSw } from '@/background/messages';
import { autoReorder, cancel, markPublishedByUser, setPaused } from '@/services/publishing/PublishingQueue';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { platformLabel } from '@/lib/platform';
import { commentBlockReason } from '@/services/autopilot/comments';
import { COMMENT_IDEAS_KEY, commentIdeas, removeCommentIdea, type CommentIdea } from '@/services/autopilot/commentIdeas';
import type { MediaItem, Platform, Post, PostStatus } from '@/types/models';
import { MediaThumb } from './MediaLibrary';
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

type Layout = 'grid' | 'list';
const LAYOUT_KEY = 'queueLayout';

function PostMedia({ ids, compact = false }: { ids: string[]; compact?: boolean }) {
  const key = ids.join('|');
  const media = useLiveQuery(async () => (ids.length ? (await db.media.bulkGet(ids)).filter((m): m is MediaItem => !!m) : []), [key]) ?? [];
  if (compact) return media[0] ? <MediaThumb m={media[0]} className="h-12 w-12 shrink-0 rounded" /> : <div className="h-12 w-12 shrink-0 rounded bg-muted" />;
  if (!media.length) return null;
  return (
    <div className={`grid gap-0.5 bg-muted ${media.length > 1 ? 'grid-cols-2' : ''}`}>
      {media.map((m) => (
        <MediaThumb key={m.id} m={m} full className="aspect-square w-full" />
      ))}
    </div>
  );
}

/** `lockPlatform`: show only that platform's posts (used by the Instagram page); the platform filter is hidden. */
export function ScheduledPostsPage({ initialView = 'queue', lockPlatform }: { initialView?: View; lockPlatform?: Platform }) {
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [view, setView] = useState<View>(initialView);
  // 'comments': replies on Threads posts plus the comment ideas still waiting for a matching post
  const [platformFilter, setPlatform] = useState<'' | Platform | 'comments'>('');
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
    .filter((p) => inView(p) && (platform === 'comments' ? !!p.replyTo : !platform || p.platform === platform) && (!status || p.status === status))
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
  const runNow = async () => {
    const ids = chosen.filter((p) => p.status === 'scheduled').map((p) => p.id);
    if (!ids.length) return toast('Only scheduled posts can be run now', 'err');
    if (!confirm(`Publish ${ids.length} post(s) now? They are posted one after another in the background.`)) return;
    setBusy(true);
    try {
      let n = 0;
      for (const postId of ids) if ((await sendToSw({ type: 'publishNow', postId })).ok) n++;
      toast(`${n} post(s) started${n < ids.length ? ` · ${ids.length - n} failed` : ''} — you will get a notification per post`);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };
  const fmt = (ms?: number) => (ms ? formatInTimeZone(ms, tz, 'dd MMM yyyy HH:mm') : '—');
  const [ideas, setIdeas] = useState<CommentIdea[]>([]);
  useEffect(() => {
    const refresh = () => void commentIdeas().then(setIdeas);
    refresh();
    const on = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c[COMMENT_IDEAS_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);
  const showCommentIdeas = view === 'queue' && ideas.length > 0 && (!platform || platform === 'threads' || platform === 'comments') && !status;
  const commentBlock = settings ? commentBlockReason(settings, posts, Date.now()) : null;
  const [commenting, setCommenting] = useState<string | null>(null);
  const commentNowFor = async (i: CommentIdea) => {
    if (!confirm(`Search Threads for "${i.title}" now and post a reply right away? (Ignores the autopilot window and the daily comment limit.)`)) return;
    setCommenting(i.id);
    try {
      const r = await sendToSw({ type: 'commentNow', ideaId: i.id });
      toast(r.message ?? (r.ok ? 'Started' : 'Failed'), r.ok ? 'ok' : 'err');
      setIdeas(await commentIdeas());
    } finally {
      setCommenting(null);
    }
  };
  const removeIdea = async (i: CommentIdea) => {
    if (!confirm(`Remove "${i.title}" from the comment list?`)) return;
    await removeCommentIdea(i.id);
    setIdeas(await commentIdeas());
  };
  const ideaActions = (i: CommentIdea) => (
    <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" disabled={!!commenting} onClick={() => commentNowFor(i)} title="Find a relevant Threads post for this idea and reply now — no time window or daily limit">
        {commenting === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />} Comment now
      </Button>
      <Button size="icon" variant="ghost" aria-label={`Remove comment idea ${i.title}`} onClick={() => removeIdea(i)}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
  const ideasNote = showCommentIdeas && (
    <p className={`text-xs ${commentBlock ? 'text-amber-500' : 'text-muted-foreground'}`}>
      {ideas.length} comment idea(s) waiting.{' '}
      {commentBlock ? `Automatic: on hold — ${commentBlock}. Use “Comment now” to reply right away.` : 'The AI searches Threads for these next; a reply appears in the queue once it finds a relevant post.'}
    </p>
  );
  const [layout, setLayoutState] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'));
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    localStorage.setItem(LAYOUT_KEY, l);
  };
  const postCheckbox = (p: Post) => (
    <input
      type="checkbox"
      aria-label={`Select post ${p.text.slice(0, 30)}`}
      disabled={!selectable(p)}
      title={selectable(p) ? undefined : 'Being published right now'}
      checked={selected.has(p.id)}
      onClick={(e) => e.stopPropagation()}
      onChange={() => toggle(p.id)}
      className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
    />
  );
  const postInfo = (p: Post) => (
    <>
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
            <span className={d.tone === 'error' ? 'text-red-500' : d.tone === 'warn' ? 'text-amber-500' : ''} title={d.text}>
              {d.text}
            </span>
          );
        })()}
    </>
  );

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
          <div className="flex h-9 overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Queue layout">
            {([['grid', 'Grid view', LayoutGrid], ['list', 'List view', List]] as const).map(([value, name, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-label={name}
                aria-checked={layout === value}
                title={name}
                onClick={() => setLayout(value)}
                className={`flex w-9 items-center justify-center ${layout === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
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
            <option value="comments">Comments (Threads)</option>
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
          <Button size="sm" disabled={busy || !chosen.some((p) => p.status === 'scheduled')} onClick={runNow} title="Publish the selected scheduled posts now">
            <Send className="h-3.5 w-3.5" /> Run now
          </Button>
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
      {list.length === 0 && !showCommentIdeas ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <>
          {ideasNote}
          {view === 'queue' && list.length > 0 && (
            <label className="flex w-fit items-center gap-2 text-sm">
              <input type="checkbox" aria-label="Select all" checked={allShownSelected} onChange={toggleAll} className="h-4 w-4 cursor-pointer accent-primary" />
              Select all
            </label>
          )}
          {layout === 'list' ? (
            <Table>
              <thead>
                <tr>
                  {view === 'queue' && <th className="w-8" aria-label="Select" />}
                  <th>Post</th>
                  <th>{view === 'history' ? 'When' : 'Scheduled'}</th>
                  <th>Platform</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {showCommentIdeas &&
                  ideas.map((i) => (
                    <tr key={`idea-${i.id}`}>
                      {view === 'queue' && <td />}
                      <td className="max-w-md">
                        <div className="text-sm font-medium">{i.title}</div>
                        <div className="line-clamp-2 break-words text-xs text-muted-foreground" title={i.body}>{i.body}</div>
                      </td>
                      <td className="whitespace-nowrap text-xs text-muted-foreground">when a match is found</td>
                      <td className="whitespace-nowrap">Threads · Comment</td>
                      <td><Badge tone="info">idea</Badge></td>
                      <td>{ideaActions(i)}</td>
                    </tr>
                  ))}
                {shown.map((p) => (
                  <tr key={p.id} className={`cursor-pointer hover:bg-muted/50 ${selected.has(p.id) ? 'bg-primary/5' : ''} ${isOnHold(p, apHeld) ? '[&>td:not(:first-child)]:opacity-60' : ''}`} onClick={() => setOpen(p)}>
                    {view === 'queue' && <td>{postCheckbox(p)}</td>}
                    <td className="max-w-md">
                      <div className="flex items-center gap-2">
                        <PostMedia ids={p.mediaIds} compact />
                        <span className="line-clamp-2 break-words" title={p.text}>{p.text}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{fmt(view === 'history' ? (p.publishedAt ?? p.updatedAt) : p.scheduledAt)}</td>
                    <td className="whitespace-nowrap">
                      {platformLabel(p.platform)}
                      {p.replyTo ? ' · Reply' : ''}
                      {p.topic ? <div className="text-xs text-muted-foreground">{p.topic}</div> : null}
                    </td>
                    <td><span className="whitespace-nowrap"><StatusBadge post={p} autopilotHeld={apHeld} /></span></td>
                    <td className="max-w-xs text-xs text-muted-foreground"><div className="line-clamp-2">{postInfo(p)}</div></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
          <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {showCommentIdeas &&
              ideas.map((i) => (
                <article key={`idea-${i.id}`} className="rounded-lg border border-dashed border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Badge tone="info">Comment · Threads</Badge>
                    {ideaActions(i)}
                  </div>
                  <div className="text-sm font-medium">{i.title}</div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{i.body}</p>
                </article>
              ))}
            {shown.map((p) => (
              <article
                key={p.id}
                className={`cursor-pointer overflow-hidden rounded-lg border bg-card transition hover:ring-2 hover:ring-primary ${selected.has(p.id) ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
                onClick={() => setOpen(p)}
              >
                <div className="flex items-center gap-2 border-b border-border p-2.5">
                  {view === 'queue' && postCheckbox(p)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {platformLabel(p.platform)}
                      {p.replyTo ? ' · Reply' : ''}
                      {p.topic ? ` · ${p.topic}` : ''}
                    </div>
                    <div className="text-xs text-muted-foreground">{fmt(view === 'history' ? (p.publishedAt ?? p.updatedAt) : p.scheduledAt)}</div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap">
                    <StatusBadge post={p} autopilotHeld={apHeld} />
                  </span>
                </div>
                <div className={isOnHold(p, apHeld) ? 'opacity-60' : ''}>
                  <PostMedia ids={p.mediaIds} />
                  <div className="space-y-2 p-3">
                    {p.replyTargetText && (
                      <blockquote className="line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground">{p.replyTargetText}</blockquote>
                    )}
                    <p className="whitespace-pre-wrap break-words text-sm">{p.text}</p>
                  </div>
                </div>
                <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{postInfo(p)}</div>
              </article>
            ))}
          </div>
          )}
        </>
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
