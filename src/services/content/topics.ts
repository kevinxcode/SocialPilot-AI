/**
 * Threads topic master list: topics the AI picks are added automatically; the user can add, disable or delete.
 */
import { db } from '@/services/storage/db';
import type { Post, ThreadsTopic } from '@/types/models';
import type { RouterLike } from './generate';
import { cleanTopic, pickTopic } from './topic';

export const topicKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Adds a topic to the master list (or bumps its use count). Returns the stored spelling. */
export async function recordTopic(name: string, source: ThreadsTopic['source'], used = true, now = Date.now()): Promise<string> {
  const id = topicKey(name);
  if (!id) return name;
  const cur = await db.topics.get(id);
  if (cur) {
    if (used) await db.topics.update(id, { uses: cur.uses + 1, lastUsedAt: now });
    return cur.name;
  }
  await db.topics.put({ id, name: name.trim(), source, enabled: true, uses: used ? 1 : 0, lastUsedAt: used ? now : undefined, createdAt: now });
  return name.trim();
}

/** Enabled topics, most used first. */
export async function enabledTopics(): Promise<string[]> {
  const all = await db.topics.toArray();
  return all.filter((t) => t.enabled).sort((a, b) => b.uses - a.uses).map((t) => t.name);
}

/** Picks a topic for a post with the AI (preferring the master list) and records it. */
export async function topicForPost(post: Pick<Post, 'text'>, router: RouterLike, now = Date.now()): Promise<string | undefined> {
  // Variety: topics used in the last 20 h are not offered again (unless every topic was used).
  const all = (await db.topics.toArray()).filter((t) => t.enabled).sort((a, b) => b.uses - a.uses);
  const fresh = all.filter((t) => !t.lastUsedAt || now - t.lastUsedAt > 20 * 3600_000);
  const preferred = (fresh.length ? fresh : all).map((t) => t.name);
  const t = await pickTopic(post.text, preferred, router);
  if (!t) return undefined;
  const known = preferred.some((p) => topicKey(p) === topicKey(t));
  return recordTopic(t, known ? 'manual' : 'ai', true, now);
}

/** Asks the AI for topic ideas for the brand and adds new ones to the master list. Returns the added names. */
export async function researchTopics(brandSummary: string, router: RouterLike, count = 10): Promise<string[]> {
  const r = await router.generate({
    purpose: 'interactive',
    temperature: 0.6,
    maxTokens: 300,
    messages: [
      {
        role: 'system',
        content: `List ${count} Threads topics (community tags) where this brand's audience is active. One per line, 1-3 words each, no #, no numbering, no explanation. Mix Indonesian and widely used English tags.`,
      },
      { role: 'user', content: brandSummary.slice(0, 3000) },
    ],
  });
  const names = r.text
    .split('\n')
    .map((l) => cleanTopic(l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '')))
    .filter((t): t is string => !!t);
  const added: string[] = [];
  for (const n of names) {
    if (await db.topics.get(topicKey(n))) continue;
    await recordTopic(n, 'ai', false);
    added.push(n);
  }
  return added;
}
