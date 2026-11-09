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

export async function markUsed(id: string): Promise<void> {
  await db.media
    .where('id')
    .equals(id)
    .modify((m) => {
      m.usedCount += 1;
      m.lastUsedAt = Date.now();
    });
}
