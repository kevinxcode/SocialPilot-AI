import { db } from '@/services/storage/db';
import type { MediaItem } from '@/types/models';

const PENDING = ['draft', 'scheduled', 'processing', 'verifying'];

/**
 * Images already attached to posts that have not been published yet. Usage is only counted on publish, so without
 * this every draft created ahead of time would pick the very same "unused" image.
 */
async function reservedIds(): Promise<Set<string>> {
  const posts = await db.posts.where('status').anyOf(PENDING).toArray();
  return new Set(posts.flatMap((p) => p.mediaIds ?? []));
}

/** Use count including pending (reserved) posts. */
function load(m: MediaItem, reserved: Set<string>): number {
  return m.usedCount + (reserved.has(m.id) ? 1 : 0);
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

async function images(): Promise<MediaItem[]> {
  return (await db.media.toArray()).filter((m) => m.type.startsWith('image/'));
}

/**
 * Autopilot media choice (images only): free (unused and not reserved by a pending post) with a matching tag → any
 * free (random) → least used / least recently used → null.
 */
export async function pickMedia(topicTags: string[]): Promise<MediaItem | null> {
  const want = new Set(topicTags.map((t) => t.toLowerCase()));
  const all = await images();
  if (!all.length) return null;
  const reserved = await reservedIds();
  const free = shuffle(all.filter((m) => load(m, reserved) === 0));
  const tagged = free.find((m) => m.tags.some((t) => want.has(t.toLowerCase())));
  if (tagged) return tagged;
  if (free.length) return free[0];
  return [...all].sort((a, b) => load(a, reserved) - load(b, reserved) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
}

/**
 * Lets the AI choose the image that fits the post text, from up to 15 candidates (least used first, shuffled so the
 * model has no position bias). Falls back to the tag-based pick on "none", an unparseable reply or any error.
 */
export async function pickMediaForText(
  text: string,
  topicTags: string[],
  router: { generate(req: { purpose: 'autopilot'; temperature: number; maxTokens: number; messages: { role: 'system' | 'user'; content: string }[] }): Promise<{ text: string }> },
): Promise<MediaItem | null> {
  const all = await images();
  const reserved = await reservedIds();
  const candidates = shuffle(
    shuffle(all)
      .sort((a, b) => load(a, reserved) - load(b, reserved) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
      .slice(0, 15),
  );
  if (candidates.length < 2) return pickMedia(topicTags);
  try {
    const r = await router.generate({
      purpose: 'autopilot',
      temperature: 0,
      maxTokens: 20,
      messages: [
        { role: 'system', content: 'Pick the image that best illustrates the social media post. Prefer images whose name/tags match the post topic. Reply ONLY with the image number, or "none" if no image fits.' },
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
