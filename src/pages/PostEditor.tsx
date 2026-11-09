import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge, Button, Dialog, Field, Input, Textarea, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { cancel, schedulePost, zonedToUtc } from '@/services/publishing/PublishingQueue';
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

export function StatusBadge({ post }: { post: Post }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={STATUS_TONE[post.status]}>{post.status}</Badge>
      {post.source === 'autopilot' && <Badge tone="info">Auto</Badge>}
    </span>
  );
}

const editable = (s: PostStatus) => s === 'draft' || s === 'scheduled' || s === 'failed' || s === 'cancelled';

export async function duplicatePost(p: Post): Promise<Post> {
  return createDraft({ platform: p.platform, text: p.text, brandId: p.brandId, title: p.title, mediaIds: p.mediaIds, contentType: p.contentType });
}

export async function deletePost(p: Post): Promise<void> {
  if (p.status === 'processing' || p.status === 'verifying') throw new Error('Post is being published; try again later');
  await db.transaction('rw', db.posts, db.queue, async () => {
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
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!post) return;
    setText(post.text);
    setMediaIds(post.mediaIds);
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
    await db.posts.update(post.id, { mediaIds });
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
          onClick={() => confirm('Delete this post?') && run(() => deletePost(post), 'Deleted')}
        >
          Delete
        </Button>
      </div>
    </Dialog>
  );
}
