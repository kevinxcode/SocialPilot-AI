/**
 * Autopilot insights from SocialPilot's own records (never invented):
 * - daily summary notification text
 * - best posting hours learned from Threads engagement
 * - best old posts to recycle with a fresh angle
 */
import { formatInTimeZone } from 'date-fns-tz';
import { platformLabel } from '@/lib/platform';
import type { Post } from '@/types/models';

const DAY = 86_400_000;

/** Summary of one calendar day (yyyy-MM-dd in tz). Null when nothing happened that day. */
export function dailySummary(posts: Post[], day: string, tz: string): { title: string; message: string } | null {
  const on = (t?: number) => t != null && formatInTimeZone(t, tz, 'yyyy-MM-dd') === day;
  const published = posts.filter((p) => p.status === 'published' && on(p.publishedAt));
  const failed = posts.filter((p) => p.status === 'failed' && on(p.updatedAt));
  if (!published.length && !failed.length) return null;
  const own = published.filter((p) => !p.replyTo);
  const replies = published.length - own.length;
  const per = (['threads', 'facebook', 'fbgroup'] as const)
    .map((pl) => [pl, own.filter((p) => p.platform === pl).length] as const)
    .filter(([, n]) => n)
    .map(([pl, n]) => `${platformLabel(pl)} ${n}`)
    .join(', ');
  const best = posts
    .filter((p) => p.status === 'published' && !p.replyTo && (p.engagement ?? 0) > 0 && (p.publishedAt ?? 0) > Date.parse(`${day}T00:00:00Z`) - 7 * DAY)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))[0];
  const lines = [
    `${own.length} published${per ? ` (${per})` : ''}${replies ? `, ${replies} replies` : ''}, ${failed.length} failed.`,
    best ? `Best this week (♥ ${best.engagement}): ${best.text.replace(/\s+/g, ' ').slice(0, 80)}` : '',
  ];
  return { title: `SocialPilot today: ${own.length} posts${failed.length ? `, ${failed.length} failed` : ''}`, message: lines.filter(Boolean).join('\n') };
}

/**
 * Hours (as minutes after midnight, at :00 + 15) whose Threads posts got the highest average engagement in the last
 * 30 days, inside the window. Null until there is enough signal: ≥ 8 measured posts across ≥ 3 different hours.
 */
export function bestMinutes(posts: Post[], tz: string, windowStart: number, windowEnd: number, now = Date.now()): number[] | null {
  const measured = posts.filter(
    (p) => p.platform === 'threads' && p.status === 'published' && !p.replyTo && p.engagement != null && now - (p.publishedAt ?? 0) < 30 * DAY,
  );
  if (measured.length < 8) return null;
  const byHour = new Map<number, number[]>();
  for (const p of measured) {
    const h = Number(formatInTimeZone(p.publishedAt!, tz, 'H'));
    byHour.set(h, [...(byHour.get(h) ?? []), p.engagement!]);
  }
  if (byHour.size < 3) return null;
  return [...byHour.entries()]
    .map(([h, v]) => ({ m: h * 60 + 15, avg: v.reduce((s, n) => s + n, 0) / v.length }))
    .filter((x) => x.m >= windowStart && x.m < windowEnd)
    .sort((a, b) => b.avg - a.avg)
    .map((x) => x.m);
}

/**
 * Slot minutes for a day: half the posts (rounded up) go to the best hours, the rest stay evenly spread so other
 * hours keep being tested. Slots are kept ≥ 45 min apart. Without data → plain even spread.
 */
export function slotMinutes(n: number, start: number, end: number, best: number[] | null): number[] {
  const seg = (end - start) / n;
  const even = Array.from({ length: n }, (_, i) => Math.round(start + (i + 0.5) * seg));
  if (!best?.length) return even;
  const out: number[] = [];
  const far = (m: number) => out.every((x) => Math.abs(x - m) >= 45);
  for (const m of best) if (out.length < Math.ceil(n / 2) && far(m)) out.push(m);
  for (const m of even) if (out.length < n && far(m)) out.push(m);
  for (const m of even) if (out.length < n && !out.includes(m)) out.push(m); // tiny windows: accept closer slots
  return out.sort((a, b) => a - b);
}

/** Best published post of this platform older than 30 days, not recycled yet, with real engagement (≥ 3). */
export function pickRecyclable(posts: Post[], platform: Post['platform'], now = Date.now()): Post | undefined {
  return posts
    .filter(
      (p) =>
        p.platform === platform &&
        p.status === 'published' &&
        !p.replyTo &&
        !p.recycledAt &&
        (p.engagement ?? 0) >= 3 &&
        now - (p.publishedAt ?? now) > 30 * DAY,
    )
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))[0];
}
