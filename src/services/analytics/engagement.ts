/**
 * Engagement feedback: once a day read the brand's own Threads profile, store likes/replies/reposts on the
 * matching published posts, and feed the best-performing angles back into the autopilot prompt.
 * Counts are read from the page only (never invented); posts that cannot be matched are left untouched.
 */
import { db, log } from '@/services/storage/db';
import type { Post } from '@/types/models';
import type { ScrapedPost } from '@/services/publishing/rpa/engine';

const norm = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
const path = (u?: string) => {
  try {
    return u ? new URL(u).pathname.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
};

/** Pairs published posts with scraped ones: same permalink first, else the post's opening text appears in the scraped text. */
export function matchEngagement(posts: Post[], scraped: ScrapedPost[]): { id: string; engagement: number }[] {
  const out: { id: string; engagement: number }[] = [];
  const used = new Set<ScrapedPost>();
  for (const p of posts) {
    const byUrl = p.url ? scraped.find((s) => !used.has(s) && path(s.url) && path(s.url) === path(p.url)) : undefined;
    const head = norm(p.text).slice(0, 30);
    const s = byUrl ?? (head.length >= 15 ? scraped.find((x) => !used.has(x) && norm(x.text).includes(head)) : undefined);
    if (!s) continue;
    used.add(s);
    out.push({ id: p.id, engagement: s.engagement });
  }
  return out;
}

/** Prompt snippet with the top posts so the AI reuses what works (without copying). Empty when there is no signal yet. */
export function angleHints(posts: Post[], n = 3): string {
  const top = posts
    .filter((p) => (p.engagement ?? 0) > 0)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
    .slice(0, n);
  if (!top.length) return '';
  return [
    'Your recent posts that got the most engagement (reuse their angle, format and hook style — never copy the text):',
    ...top.map((p, i) => `${i + 1}. [${p.contentType ?? 'post'}, engagement ${p.engagement}] ${p.text.replace(/\s+/g, ' ').slice(0, 200)}`),
  ].join('\n');
}

/** Best Threads autopilot/manual posts of the last 30 days, for the prompt. */
export async function recentAngleHints(now = Date.now()): Promise<string> {
  const posts = await db.posts.where('platform').equals('threads').toArray();
  return angleHints(posts.filter((p) => p.status === 'published' && now - (p.publishedAt ?? 0) < 30 * 86_400_000));
}

/** Reads the profile and stores engagement on published Threads posts from the last 14 days. Returns the number updated. */
export async function refreshEngagement(scrapeProfile: () => Promise<ScrapedPost[]>, now = Date.now()): Promise<number> {
  const posts = (await db.posts.where('platform').equals('threads').toArray()).filter(
    (p) => p.status === 'published' && !p.replyTo && now - (p.publishedAt ?? 0) < 14 * 86_400_000 && now - (p.publishedAt ?? 0) > 6 * 3600_000,
  );
  if (!posts.length) return 0;
  const matches = matchEngagement(posts, await scrapeProfile());
  for (const m of matches) await db.posts.update(m.id, { engagement: m.engagement, engagementAt: now });
  await log('info', 'analytics', `Engagement updated for ${matches.length}/${posts.length} recent Threads posts`);
  return matches.length;
}
