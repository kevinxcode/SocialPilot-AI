import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { generateVariations, type RouterLike } from '@/services/content/generate';
import { validatePost } from '@/services/content/validate';
import { contentTypeLabel } from '@/services/content/prompts';
import { pickMedia } from '@/services/media/pick';
import { createDraft } from '@/services/publishing/posts';
import { cancel, schedulePost } from '@/services/publishing/PublishingQueue';
import { aiRouter } from '@/services/ai/AIRouter';
import type { ProviderId, QueueItem } from '@/types/models';

type Notify = (title: string, message: string, id?: string, buttons?: { title: string }[]) => void;
export interface RunnerCtx {
  notify: Notify;
  router?: RouterLike;
  onScheduled?: () => void;
}

const label = (p: string) => (p === 'threads' ? 'Threads' : 'Facebook');

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

async function skip(item: QueueItem, reason: string, ctx: RunnerCtx) {
  await db.queue.delete(item.id);
  await log('warn', 'autopilot', `${label(item.platform)} slot ${item.slotKey}: skipped — ${reason}`);
  ctx.notify(`Autopilot skipped a ${label(item.platform)} post`, reason.slice(0, 200));
}

async function activeBrandId(preferred?: string): Promise<string | undefined> {
  if (preferred && (await db.brands.get(preferred))) return preferred;
  return (await db.brands.orderBy('name').first())?.id;
}

/** Generates (once + one regeneration), validates, picks media and schedules an autopilot post. */
export async function runSlot(item: QueueItem, now: number, ctx: RunnerCtx): Promise<void> {
  const s = await getSettings();
  const a = s.autopilot;
  if (!a.enabled || a.paused || !a.platforms[item.platform]) {
    await db.queue.delete(item.id);
    await log('info', 'autopilot', `${label(item.platform)} slot ${item.slotKey} dropped (autopilot off or paused)`);
    return;
  }
  const account = await db.accounts.where('platform').equals(item.platform).first();
  if (!account) return skip(item, `No ${item.platform === 'threads' ? 'Threads account' : 'Facebook Page'} configured`, ctx);
  const brandId = await activeBrandId(s.activeBrandId);
  if (!brandId) return skip(item, 'No brand in the knowledge base', ctx);

  const ideas = await db.ideas.where('brandId').equals(brandId).toArray();
  const idea = ideas.length ? ideas[hash(item.slotKey ?? item.id) % ideas.length] : undefined;
  const contentType = item.contentType ?? 'educational';
  const input = {
    brandId,
    topic: idea ? `${idea.title}${idea.body ? ` — ${idea.body}` : ''}` : '',
    objective: 'awareness and engagement',
    audience: '',
    language: a.language,
    platform: item.platform,
    contentType,
    tone: '',
    cta: '',
    hashtags: '',
    extra: idea ? undefined : `Pick a fresh, specific ${contentTypeLabel(contentType)} topic relevant to the audience of this brand.`,
  };

  let caption = '';
  let meta: { providerId?: ProviderId; modelId?: string } = {};
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const extra =
      attempt === 0
        ? input.extra
        : `${input.extra ?? ''}\nThe previous draft was rejected: ${errors.join('; ')}. Fix this — do not include any number, price or percentage that is not in the knowledge base.`;
    try {
      const out = await generateVariations({ ...input, extra }, 1, { router: ctx.router ?? aiRouter, purpose: 'autopilot' });
      caption = out[0]?.caption ?? '';
      meta = { providerId: out.meta?.providerId, modelId: out.meta?.modelId };
    } catch (e) {
      return skip(item, `AI generation failed: ${(e as Error).message}`, ctx);
    }
    const v = await validatePost(caption, item.platform, brandId);
    errors = v.errors;
    if (v.ok) break;
  }
  if (errors.length) return skip(item, `Generated text failed checks twice: ${errors.join('; ')}`, ctx);

  const tags = [contentType, ...contentType.split('-'), ...(idea?.title.toLowerCase().split(/\s+/) ?? [])];
  const media = a.attachMedia ? await pickMedia(tags) : null;
  const post = await createDraft({
    platform: item.platform,
    text: caption,
    brandId,
    title: idea?.title,
    mediaIds: media ? [media.id] : [],
    source: 'autopilot',
    contentType,
    providerId: meta.providerId,
    modelId: meta.modelId,
  });
  const review = a.reviewWindowMinutes > 0;
  await schedulePost(post.id, new Date(review ? now + a.reviewWindowMinutes * 60_000 : now));
  await db.queue.delete(item.id);
  await log('info', 'autopilot', `${label(item.platform)} post generated for slot ${item.slotKey}${review ? ` (review window ${a.reviewWindowMinutes} min)` : ''}`);
  if (review) {
    ctx.notify(
      `Autopilot ${label(item.platform)} post — review`,
      `Posts in ${a.reviewWindowMinutes} min unless rejected: ${caption.slice(0, 120)}`,
      `review:${post.id}`,
      [{ title: 'Approve now' }, { title: 'Reject' }],
    );
  }
  ctx.onScheduled?.();
}

export async function reviewDecision(postId: string, approve: boolean, ctx: RunnerCtx): Promise<void> {
  const p = await db.posts.get(postId);
  if (!p || p.status !== 'scheduled') return;
  if (approve) {
    await schedulePost(postId, new Date());
    ctx.onScheduled?.();
  } else {
    await cancel(postId);
    await log('info', 'autopilot', `${label(p.platform)} autopilot post rejected by user`);
  }
}
