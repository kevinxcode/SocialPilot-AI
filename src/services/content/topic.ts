/**
 * Threads "Community or topic" picker: the AI chooses one topic per post, preferring the user's list.
 */
import type { RouterLike } from './generate';

export const TOPIC_MAX = 50;

/** Normalises an AI reply into one clean topic, or null when unusable. */
export function cleanTopic(raw: string): string | null {
  const line = (raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const t = line
    .replace(/^(topic|topik)\s*:\s*/i, '')
    .replace(/^[#"'`*\s-]+|["'`*.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > TOPIC_MAX || /[\n]/.test(t)) return null;
  return t;
}

/** Prefer the exact spelling from the user's list when the AI picked one of them. */
export function matchPreferred(topic: string, preferred: string[]): string {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return preferred.find((p) => key(p) === key(topic)) ?? topic;
}

export async function pickTopic(text: string, preferred: string[], router: RouterLike): Promise<string | undefined> {
  const list = preferred.filter((p) => p.trim());
  try {
    const r = await router.generate({
      purpose: 'autopilot',
      temperature: 0.2,
      maxTokens: 30,
      messages: [
        {
          role: 'system',
          content:
            'You choose ONE Threads topic (community tag) for a post so it reaches the right audience. Reply with the topic only: 1-3 words, no #, no quotes, no explanation.',
        },
        {
          role: 'user',
          content: `${list.length ? `Prefer one of these existing topics if it fits: ${list.join(', ')}.\nOtherwise suggest a popular Indonesian topic.\n\n` : ''}Post:\n${text.slice(0, 1500)}`,
        },
      ],
    });
    const t = cleanTopic(r.text);
    if (t) return matchPreferred(t, list);
  } catch {
    /* fall through to the first preferred topic */
  }
  return list[0];
}
