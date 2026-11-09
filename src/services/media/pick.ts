import { db } from '@/services/storage/db';
import type { MediaItem } from '@/types/models';

/**
 * Autopilot media choice (images only): unused with a matching tag → any unused → least recently used → null.
 */
export async function pickMedia(topicTags: string[]): Promise<MediaItem | null> {
  const want = new Set(topicTags.map((t) => t.toLowerCase()));
  const images = (await db.media.toArray()).filter((m) => m.type.startsWith('image/'));
  if (!images.length) return null;
  const unused = images.filter((m) => m.usedCount === 0).sort((a, b) => a.createdAt - b.createdAt);
  const tagged = unused.find((m) => m.tags.some((t) => want.has(t.toLowerCase())));
  if (tagged) return tagged;
  if (unused.length) return unused[0];
  return [...images].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
}

/**
 * Lets the AI choose the image that fits the post text, from up to 15 candidates (unused first, then least recently
 * used). Falls back to the tag-based pick on "none", an unparseable reply or any error.
 */
export async function pickMediaForText(
  text: string,
  topicTags: string[],
  router: { generate(req: { purpose: 'autopilot'; temperature: number; maxTokens: number; messages: { role: 'system' | 'user'; content: string }[] }): Promise<{ text: string }> },
): Promise<MediaItem | null> {
  const images = (await db.media.toArray()).filter((m) => m.type.startsWith('image/'));
  const candidates = [...images]
    .sort((a, b) => Number(a.usedCount > 0) - Number(b.usedCount > 0) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
    .slice(0, 15);
  if (candidates.length < 2) return pickMedia(topicTags);
  try {
    const r = await router.generate({
      purpose: 'autopilot',
      temperature: 0,
      maxTokens: 20,
      messages: [
        { role: 'system', content: 'Pick the image that best illustrates the social media post. Reply ONLY with the image number, or "none" if no image fits.' },
        {
          role: 'user',
          content: `Post:\n${text.slice(0, 600)}\n\nImages:\n${candidates
            .map((m, i) => `${i + 1}. ${m.name}${m.tags.length ? ` — tags: ${m.tags.join(', ')}` : ''}${m.category ? ` — ${m.category}` : ''}`)
            .join('\n')}`,
        },
      ],
    });
    const n = Number(r.text.replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\d+/)?.[0]);
    if (n >= 1 && n <= candidates.length) return candidates[n - 1];
  } catch {
    /* fall back below */
  }
  return pickMedia(topicTags);
}

export async function markUsed(id: string): Promise<void> {
  await db.media
    .where('id')
    .equals(id)
    .modify((m) => {
      m.usedCount += 1;
      m.lastUsedAt = Date.now();
    });
}
