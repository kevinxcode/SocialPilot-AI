import { formatInTimeZone } from 'date-fns-tz';
import type { Platform, Post } from '@/types/models';

export interface Stats {
  published: number;
  failed: number;
  scheduled: number;
  drafts: number;
  autopilot: number;
  /** published / (published + failed); null when nothing was attempted */
  successRate: number | null;
  perPlatform: Record<Platform, { published: number; failed: number }>;
  byContentType: Record<string, number>;
  byDay: { day: string; published: number; failed: number }[];
  /** Engagement is never scraped or invented. */
  engagement: 'N/A';
}

/** Statistics computed only from SocialPilot's own post records. */
export function computeStats(posts: Post[], range: { from: number; to: number }, tz: string): Stats {
  const inRange = (t?: number) => t != null && t >= range.from && t <= range.to;
  const pub = posts.filter((p) => p.status === 'published' && inRange(p.publishedAt));
  const failed = posts.filter((p) => p.status === 'failed' && inRange(p.updatedAt));
  const perPlatform: Stats['perPlatform'] = { threads: { published: 0, failed: 0 }, facebook: { published: 0, failed: 0 }, fbgroup: { published: 0, failed: 0 } };
  const byContentType: Record<string, number> = {};
  for (const p of pub) {
    perPlatform[p.platform].published++;
    const k = p.contentType ?? 'other';
    byContentType[k] = (byContentType[k] ?? 0) + 1;
  }
  for (const p of failed) perPlatform[p.platform].failed++;

  const days: Stats['byDay'] = [];
  const index = new Map<string, Stats['byDay'][number]>();
  const nDays = Math.min(120, Math.max(1, Math.round((range.to - range.from) / 86_400_000)));
  for (let i = nDays - 1; i >= 0; i--) {
    const day = formatInTimeZone(range.to - i * 86_400_000, tz, 'yyyy-MM-dd');
    if (index.has(day)) continue;
    const row = { day, published: 0, failed: 0 };
    index.set(day, row);
    days.push(row);
  }
  for (const p of pub) {
    const r = index.get(formatInTimeZone(p.publishedAt!, tz, 'yyyy-MM-dd'));
    if (r) r.published++;
  }
  for (const p of failed) {
    const r = index.get(formatInTimeZone(p.updatedAt, tz, 'yyyy-MM-dd'));
    if (r) r.failed++;
  }

  const attempted = pub.length + failed.length;
  return {
    published: pub.length,
    failed: failed.length,
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    drafts: posts.filter((p) => p.status === 'draft').length,
    autopilot: pub.filter((p) => p.source === 'autopilot').length,
    successRate: attempted ? pub.length / attempted : null,
    perPlatform,
    byContentType,
    byDay: days,
    engagement: 'N/A',
  };
}
