import { takeTrendingIdea } from '@/services/content/trending';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { generateVariations, type RouterLike } from '@/services/content/generate';
import { LIMITS, validatePost } from '@/services/content/validate';
import { qualityIssues } from '@/services/content/quality';
import { recentAngleHints } from '@/services/analytics/engagement';
import { appendLink, withUtm } from '@/lib/utm';
import { groupInstructions } from '@/services/content/groupPrompt';
export { groupInstructions };
import { contentTypeLabel } from '@/services/content/prompts';
import { pickMedia, pickMediaForText } from '@/services/media/pick';
import { pickRecyclable } from './insights';
import { createDraft } from '@/services/publishing/posts';
import { cancel, schedulePost } from '@/services/publishing/PublishingQueue';
import { aiRouter } from '@/services/ai/AIRouter';
import type { FbGroup, Platform, ProviderId, QueueItem } from '@/types/models';
import { platformLabel } from '@/lib/platform';

type Notify = (title: string, message: string, id?: string, buttons?: { title: string }[]) => void;
export interface RunnerCtx {
  notify: Notify;
  router?: RouterLike;
  onScheduled?: () => void;
}

const label = (p: Platform) => platformLabel(p);

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
  let group: FbGroup | undefined;
  if (item.platform === 'fbgroup') {
    group = await pickGroup(now);
    if (!group) return skip(item, 'No enabled Facebook Group available (each group gets at most 1 post per 24 h)', ctx);
  } else {
    const account = await db.accounts.where('platform').equals(item.platform).first();
    if (!account) return skip(item, `No ${label(item.platform)} configured`, ctx);
  }
  const brandId = await activeBrandId(s.activeBrandId);
  if (!brandId) return skip(item, 'No brand in the knowledge base', ctx);

  // Fresh trending ideas (daily research) first; otherwise rotate through saved ideas.
  const ideas = (await db.ideas.where('brandId').equals(brandId).toArray()).filter((i) => !i.kind.startsWith('trending'));
  const trending = s.trendingResearch ? await takeTrendingIdea(brandId, now) : undefined;
  // No fresh trend → reuse a proven winner (>30 days old) with a new angle, else rotate saved ideas.
  const recycled = !trending && item.platform !== 'fbgroup' && a.recycle !== false ? pickRecyclable(await db.posts.toArray(), 'threads', now) : undefined;
  const idea =
    trending ??
    (recycled
      ? {
          title: recycled.title ?? 'Recycled winner',
          body: `This earlier post got high engagement. Write a NEW post on the same idea with a fresh angle, new hook and new wording — never copy its sentences: "${recycled.text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 400)}"`,
        }
      : undefined) ??
    (ideas.length ? ideas[hash(item.slotKey ?? item.id) % ideas.length] : undefined);
  const contentType = item.contentType ?? 'educational';
  const brand = await db.brands.get(brandId);
  const hints = a.learnFromEngagement !== false ? await recentAngleHints(now) : '';
  const input = {
    brandId,
    topic: idea ? `${idea.title}${idea.body ? ` — ${idea.body}` : ''}` : '',
    objective: 'awareness and engagement',
    audience: '',
    language: a.language,
    platform: item.platform,
    contentType,
    tone: '',
    // Group posts stay non-salesy; elsewhere every post ends with the brand's CTA.
    cta: group ? '' : (brand?.cta ?? '').trim(),
    hashtags: '',
    extra:
      [
        idea ? '' : `Pick a fresh, specific ${contentTypeLabel(contentType)} topic relevant to the audience of this brand.`,
        group ? groupInstructions(group) : '',
        hints,
        'Do not put any URL in the text.',
      ]
        .filter(Boolean)
        .join('\n') || undefined,
  };

  let caption = '';
  let meta: { providerId?: ProviderId; modelId?: string } = {};
  let errors: string[] = [];
  // Up to 3 drafts: each rejected draft's problems are fed back so the next one fixes them.
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (item.platform === 'threads' && a.ctaLink !== false && brand?.website) {
      const link = withUtm(brand.website, 'threads');
      if (link) caption = appendLink(caption, link, LIMITS.threads);
    }
    const v = await validatePost(caption, item.platform, brandId);
    errors = [...v.errors, ...qualityIssues(caption, a.language)];
    if (!errors.length) break;
    await log('info', 'autopilot', `${label(item.platform)} draft ${attempt + 1} rejected: ${errors.join('; ')}`);
  }
  if (errors.length) return skip(item, `Generated text failed checks 3 times: ${errors.join('; ')}`, ctx);

  const tags = [contentType, ...contentType.split('-'), ...(idea?.title.toLowerCase().split(/\s+/) ?? [])];
  const media = !a.attachMedia ? null : a.aiImagePick !== false ? await pickMediaForText(caption, tags, ctx.router ?? aiRouter) : await pickMedia(tags);
  const post = await createDraft({
    autoMedia: false,
    groupId: group?.id,
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
  if (recycled) await db.posts.update(recycled.id, { recycledAt: now });
  await log('info', 'autopilot', `${label(item.platform)} post generated for slot ${item.slotKey}${recycled ? ' (recycled winner)' : ''}${review ? ` (review window ${a.reviewWindowMinutes} min)` : ''}`);
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


/** Enabled group with the oldest last post, excluding groups posted to (or scheduled) in the last 24 h. */
async function pickGroup(now: number): Promise<FbGroup | undefined> {
  const groups = (await db.groups.toArray()).filter((g) => g.enabled);
  const posts = await db.posts.where('platform').equals('fbgroup').toArray();
  const lastAt = (g: FbGroup) =>
    Math.max(
      0,
      ...posts
        .filter((p) => p.groupId === g.id && (p.status === 'published' || p.status === 'scheduled'))
        .map((p) => p.publishedAt ?? p.scheduledAt ?? 0),
    );
  return groups.filter((g) => now - lastAt(g) >= 24 * 60 * 60_000).sort((x, y) => lastAt(x) - lastAt(y))[0];
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
