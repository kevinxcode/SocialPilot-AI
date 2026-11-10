import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge, Button, Dialog, Field, Input, Textarea, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { cancel, isBeingWorkedOn, schedulePost, zonedToUtc } from '@/services/publishing/PublishingQueue';
import { createDraft, updatePostText } from '@/services/publishing/posts';
import { validatePost, visibleLength, LIMITS } from '@/services/content/validate';
import { sendToSw } from '@/background/messages';
import type { Post, PostStatus } from '@/types/models';
import { MediaPicker, toZonedInput } from './PostActions';
import { platformLabel } from '@/lib/platform';

export const STATUS_TONE: Record<PostStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'default',
  scheduled: 'info',
  processing: 'warning',
  verifying: 'warning',
  published: 'success',
  failed: 'danger',
  cancelled: 'default',
};

/** A waiting post that will not be published for now: paused by the user, or an autopilot post while autopilot is paused/off. */
export function isOnHold(post: Post, autopilotHeld = false): boolean {
  return post.status === 'scheduled' && (!!post.paused || (post.source === 'autopilot' && autopilotHeld));
}

/** One status per post: a held post shows "paused" instead of "scheduled" (never both). */
export function StatusBadge({ post, autopilotHeld = false }: { post: Post; autopilotHeld?: boolean }) {
  const held = isOnHold(post, autopilotHeld);
  return (
    <span className="inline-flex items-center gap-1">
      {held ? <Badge tone="warning">paused</Badge> : <Badge tone={STATUS_TONE[post.status]}>{post.status}</Badge>}
      {post.source === 'autopilot' && <Badge tone="info">Auto</Badge>}
    </span>
  );
}

/**
 * Plain-language "Details" for the post lists: what happens next, and why.
 * Old errors of a post that will be retried are labelled as the LAST attempt, so they are not read as the current state.
 */
export function postDetail(post: Post, fmt: (ms?: number) => string, autopilotHeld = false): { text: string; tone: 'muted' | 'warn' | 'error' } {
  if (post.status === 'scheduled' && post.paused) return { text: 'Paused by you — not published until you select it and click Resume', tone: 'warn' };
  if (isOnHold(post, autopilotHeld)) return { text: 'Autopilot is paused — this post waits until autopilot runs again', tone: 'warn' };
  const err = post.error ?? '';
  if (post.status === 'scheduled' && err.startsWith('Waiting:')) return { text: err, tone: 'muted' };
  if (post.status === 'scheduled' && err) return { text: `Last attempt failed: ${err}${post.nextRetryAt ? ` · next try ${fmt(post.nextRetryAt)}` : ''}`, tone: 'warn' };
  if (post.status === 'failed') return { text: err || 'Failed', tone: 'error' };
  if (post.status === 'verifying') return { text: err || 'Checking whether it was already posted before trying again', tone: 'warn' };
  if (post.status === 'processing') return { text: 'Being published now…', tone: 'muted' };
  return { text: err || post.note || (post.nextRetryAt ? `next try ${fmt(post.nextRetryAt)}` : ''), tone: 'muted' };
}

const editable = (s: PostStatus) => s === 'draft' || s === 'scheduled' || s === 'failed' || s === 'cancelled';

export async function duplicatePost(p: Post): Promise<Post> {
  return createDraft({ platform: p.platform, text: p.text, brandId: p.brandId, title: p.title, mediaIds: p.mediaIds, contentType: p.contentType });
}

/**
 * Deletes the post from SocialPilot. Refused only while it is really being published or checked right now; a post
 * that is just waiting for its next feed check ('verifying') can be deleted (it is not posted again — a copy that is
 * already live on the platform stays there).
 */
export async function deletePost(p: Post): Promise<void> {
  await db.transaction('rw', db.posts, db.queue, async () => {
    const cur = await db.posts.get(p.id);
    if (cur?.status === 'processing' || (await isBeingWorkedOn(p.id))) throw new Error('Post is being published right now; try again in a minute');
    await db.queue.where('postId').equals(p.id).delete();
    await db.posts.delete(p.id);
  });
}

export function PostEditor({ post, onClose }: { post: Post | null; onClose: () => void }) {
  const toast = useToast();
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!post) return;
    setText(post.text);
    setMediaIds(post.mediaIds);
    setTopic(post.topic ?? '');
    setWhen(toZonedInput(post.scheduledAt && post.scheduledAt > Date.now() ? post.scheduledAt : Date.now() + 60 * 60_000, tz));
  }, [post, tz]);
  useEffect(() => {
    if (post?.brandId) validatePost(text, post.platform, post.brandId).then((r) => setErrors(r.errors));
    else setErrors(text.trim() ? [] : ['Post text is empty']);
  }, [text, post]);

  if (!post) return null;
  const canEdit = editable(post.status);
  const save = async () => {
    await updatePostText(post.id, text);
    await db.posts.update(post.id, { mediaIds, topic: topic.trim() || undefined });
  };
  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      toast(okMsg);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${platformLabel(post.platform)} post`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge post={post} />
        {post.attempts > 0 && <span>attempts {post.attempts}</span>}
        {post.publishedAt && <span>published {new Date(post.publishedAt).toLocaleString()}</span>}
        {post.url && (
          <a className="inline-flex items-center gap-1 text-primary underline" href={post.url} target="_blank" rel="noreferrer">
            open <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {post.note && <p className="mb-2 rounded bg-amber-500/10 p-2 text-xs text-amber-700">{post.note}</p>}
      {post.error && <p className="mb-2 rounded bg-red-500/10 p-2 text-xs text-red-600">{post.error}</p>}
      <Textarea rows={9} value={text} disabled={!canEdit} onChange={(e) => setText(e.target.value)} aria-label="Post text" />
      <div className="mt-1 flex justify-between text-xs">
        <span className="text-red-500">{errors.join(' · ')}</span>
        <span className="text-muted-foreground">
          {visibleLength(text)}
          {post.platform === 'threads' ? `/${LIMITS.threads}` : ''}
        </span>
      </div>
      {canEdit && (
        <>
          <div className="mt-3 flex items-end gap-2">
            <Field label={`Schedule (${tz})`}>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <MediaPicker value={mediaIds} onChange={setMediaIds} />
          </div>
          {post.platform === 'threads' && (
            <div className="mt-2">
              <Field label="Topic (empty = AI picks one when posting)">
                <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Bisnis Laundry" maxLength={50} />
              </Field>
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => run(save, 'Saved')}>
              Save
            </Button>
            <Button
              disabled={errors.length > 0}
              onClick={() =>
                run(async () => {
                  const at = zonedToUtc(when, tz);
                  if (at.getTime() < Date.now() - 60_000) throw new Error('That time is in the past');
                  await save();
                  await schedulePost(post.id, at);
                }, 'Scheduled')
              }
            >
              {post.status === 'failed' ? 'Retry at this time' : 'Schedule'}
            </Button>
            <Button
              variant="secondary"
              disabled={errors.length > 0}
              onClick={() =>
                run(async () => {
                  if (!confirm('Publish now?')) throw new Error('Cancelled');
                  await save();
                  const r = await sendToSw({ type: 'publishNow', postId: post.id });
                  if (!r.ok) throw new Error(r.message);
                }, 'Publishing started')
              }
            >
              Publish now
            </Button>
          </div>
        </>
      )}
      <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-border pt-3">
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => run(() => duplicatePost(post), 'Duplicated as draft')}>
            Duplicate
          </Button>
          {post.status === 'scheduled' && (
            <Button size="sm" variant="ghost" onClick={() => run(() => cancel(post.id), 'Cancelled')}>
              Cancel schedule
            </Button>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-500"
          onClick={() => confirm(post.status === 'verifying' ? 'Delete this post from SocialPilot? It will not be posted again. If it is already live on the platform, it stays there — delete it there yourself if needed.' : 'Delete this post?') && run(() => deletePost(post), 'Deleted')}
        >
          Delete
        </Button>
      </div>
    </Dialog>
  );
}
