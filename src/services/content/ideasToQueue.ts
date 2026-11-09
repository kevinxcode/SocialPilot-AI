/**
 * Saved ideas → generated posts scheduled in the queue, spaced by the minimum gap inside the autopilot window.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { generateVariations, type RouterLike } from './generate';
import { validatePost } from './validate';
import { createDraft } from '@/services/publishing/posts';
import { schedulePost } from '@/services/publishing/PublishingQueue';
import type { Platform } from '@/types/models';

/** Next allowed times: ≥ start, spaced by gapMs, only inside [windowStart, windowEnd] in tz. */
export function spreadTimes(start: number, count: number, gapMs: number, tz: string, windowStart: string, windowEnd: string): number[] {
  const out: number[] = [];
  let t = start;
  for (let guard = 0; out.length < count && guard < 1000; guard++) {
    const day = formatInTimeZone(t, tz, 'yyyy-MM-dd');
    const hm = formatInTimeZone(t, tz, 'HH:mm');
    if (hm < windowStart) t = fromZonedTime(`${day}T${windowStart}`, tz).getTime();
    else if (hm > windowEnd) {
      const next = formatInTimeZone(t + 24 * 3600_000, tz, 'yyyy-MM-dd');
      t = fromZonedTime(`${next}T${windowStart}`, tz).getTime();
    } else {
      out.push(t);
      t += gapMs;
    }
  }
  return out;
}

export async function queueIdeas(
  ideaIds: string[],
  opts: { platform: Platform; router?: RouterLike; now?: number; onProgress?: (done: number) => void },
): Promise<{ queued: number; failed: string[]; queuedIds: string[] }> {
  const s = await getSettings();
  const now = opts.now ?? Date.now();
  const groups = opts.platform === 'fbgroup' ? (await db.groups.toArray()).filter((g) => g.enabled) : [];
  if (opts.platform === 'fbgroup' && !groups.length) throw new Error('No enabled Facebook Group — switch some on in Grup Facebook first');
  const gapMs = (opts.platform === 'fbgroup' ? s.groupGapMinutes : s.minGapMinutes) * 60_000;
  // Start after everything already scheduled/published on this platform.
  const existing = await db.posts.where('platform').equals(opts.platform).toArray();
  const latest = Math.max(
    0,
    ...existing.filter((p) => p.status === 'scheduled' && p.scheduledAt).map((p) => p.scheduledAt!),
    ...existing.filter((p) => p.publishedAt).map((p) => p.publishedAt!),
  );
  const start = Math.max(now + 5 * 60_000, latest ? latest + gapMs : 0);
  const times = spreadTimes(start, ideaIds.length, gapMs, s.timezone, s.autopilot.windowStart, s.autopilot.windowEnd);

  let queued = 0;
  const queuedIds: string[] = [];
  const failed: string[] = [];
  for (const id of ideaIds) {
    const idea = await db.ideas.get(id);
    if (!idea) continue;
    const brandId = idea.brandId ?? s.activeBrandId ?? (await db.brands.toCollection().first())?.id;
    try {
      if (!brandId) throw new Error('No brand');
      // Groups: rotate through enabled groups, one post per group (the queue enforces max 1 per group per 24 h).
      const group = groups.length ? groups[queued % groups.length] : undefined;
      const out = await generateVariations(
        {
          brandId,
          topic: `${idea.title}${idea.body ? ` — ${idea.body}` : ''}`,
          objective: 'awareness and engagement',
          audience: '',
          language: s.autopilot.language,
          platform: opts.platform,
          contentType: 'educational',
          tone: '',
          cta: '',
          hashtags: '',
          extra: group ? `Facebook Group "${group.name}".${group.rules ? ` Group rules you MUST follow: ${group.rules}` : ''} Write a helpful community post, no hard selling.` : undefined,
        },
        1,
        { router: opts.router, purpose: 'interactive' },
      );
      const text = out[0]?.caption ?? '';
      const v = await validatePost(text, opts.platform, brandId);
      if (!v.ok) throw new Error(v.errors.join('; '));
      const post = await createDraft({ platform: opts.platform, text, brandId, title: idea.title, contentType: 'educational', groupId: group?.id });
      await schedulePost(post.id, new Date(times[queued]));
      queued++;
      queuedIds.push(id);
      opts.onProgress?.(queued);
    } catch (e) {
      failed.push(`${idea.title}: ${(e as Error).message}`);
    }
  }
  await log('info', 'research', `Queued ${queued} posts from ideas${failed.length ? `, ${failed.length} failed` : ''}`);
  return { queued, failed, queuedIds };
}
