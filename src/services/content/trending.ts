import { getSettings } from '@/services/storage/settings';
/**
 * Daily trending research: read the most engaged Threads posts for the brand's topics and turn them into
 * fresh post ideas (saved as ideas of kind "trending", which autopilot uses first).
 */
import { db, log } from '@/services/storage/db';
import { uid } from '@/lib/utils';
import type { ScrapedPost } from '@/services/publishing/rpa/engine';
import type { RouterLike } from './generate';
import { enabledTopics, recordTopic } from './topics';
import { cleanTopic } from './topic';

export const TRENDING_KIND = 'trending';
const LAST_RUN_KEY = 'trendingLastRun';

export interface TrendingIdea {
  title: string;
  body: string;
  topic?: string;
}

/** Parses "TITLE | ANGLE | TOPIC" lines from the AI. */
export function parseIdeas(text: string): TrendingIdea[] {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [title, body, topic] = l.split('|').map((x) => x.trim());
      return { title, body: body ?? '', topic: topic ? (cleanTopic(topic) ?? undefined) : undefined };
    })
    .filter((i) => i.title && i.title.length <= 140);
}

export async function researchTrending(
  deps: { scrape: (queries: string[]) => Promise<{ query: string; posts: ScrapedPost[] }[]>; router: RouterLike },
  brand: { id: string; name: string; summary: string },
  now = Date.now(),
): Promise<TrendingIdea[]> {
  const queries = (await enabledTopics()).slice(0, 3);
  if (!queries.length) queries.push('bisnis laundry', 'UMKM');
  const lang = (await getSettings()).autopilot.language === 'en' ? 'English' : 'Bahasa Indonesia';
  const results = await deps.scrape(queries);
  const top = results
    .flatMap((r) => r.posts.map((p) => ({ ...p, query: r.query })))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 15);
  if (!top.length) throw new Error('No Threads posts found for the research topics (logged out or search UI changed?)');

  const r = await deps.router.generate({
    purpose: 'autopilot',
    temperature: 0.7,
    maxTokens: 700,
    messages: [
      {
        role: 'system',
        content:
          `You are a social media strategist. From the trending Threads posts below, propose 6 ORIGINAL post ideas for the brand, each on a different angle that is currently getting engagement. Never copy text. Write everything in ${lang}. One idea per line exactly as: TITLE | ANGLE (one sentence) | TOPIC (1-3 words, no #).`,
      },
      {
        role: 'user',
        content: `Brand: ${brand.name}\n${brand.summary.slice(0, 1200)}\n\nTrending posts (most engaged first):\n${top
          .map((p, i) => `${i + 1}. [${p.query}, engagement ${p.engagement}] ${p.text.slice(0, 280)}`)
          .join('\n')}`,
      },
    ],
  });
  const ideas = parseIdeas(r.text).slice(0, 6);
  for (const i of ideas) {
    await db.ideas.add({ id: uid(), brandId: brand.id, title: i.title, body: `${i.body}${i.topic ? ` [topic: ${i.topic}]` : ''}`, kind: TRENDING_KIND, createdAt: now });
    if (i.topic) await recordTopic(i.topic, 'ai', false, now);
  }
  await log('info', 'research', `Trending research: ${ideas.length} ideas from ${top.length} posts (${queries.join(', ')})`);
  return ideas;
}

/** Runs once per calendar day (in the given timezone) when called from the scheduler tick. */
export async function maybeDailyTrending(dayKey: string, run: () => Promise<unknown>): Promise<boolean> {
  const last = (await chrome.storage.local.get(LAST_RUN_KEY))[LAST_RUN_KEY] as string | undefined;
  if (last === dayKey) return false;
  await chrome.storage.local.set({ [LAST_RUN_KEY]: dayKey });
  try {
    await run();
  } catch (e) {
    await log('warn', 'research', `Trending research failed: ${(e as Error).message}`);
  }
  return true;
}

/** Autopilot: newest unused trending idea from the last 48 h, else undefined. Marks it used by renaming its kind. */
export async function takeTrendingIdea(brandId: string, now = Date.now()) {
  const fresh = (await db.ideas.where('brandId').equals(brandId).toArray())
    .filter((i) => i.kind === TRENDING_KIND && now - i.createdAt < 48 * 3600_000)
    .sort((a, b) => b.createdAt - a.createdAt);
  const idea = fresh[0];
  if (idea) await db.ideas.update(idea.id, { kind: `${TRENDING_KIND}-used` });
  return idea;
}
