import type { Platform } from '@/types/models';
import { platformLabel } from '@/lib/platform';
import { allowedFacts, extractFacts } from './brandContext';

export const LIMITS: Record<Platform, number> = { threads: 500, facebook: 63_206, fbgroup: 63_206, instagram: 2200 };
/** Instagram rejects captions with more than 30 hashtags. */
export const MAX_HASHTAGS: Partial<Record<Platform, number>> = { instagram: 30 };

export function visibleLength(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
}

/** Facts in text that the brand KB does not contain. Hashtags/URLs ignored; bare counts 1–10 allowed (e.g. "3 tips"). */
export async function unknownFacts(text: string, brandId: string): Promise<string[]> {
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const allowed = await allowedFacts(brandId);
  return [...extractFacts(cleaned)].filter((f) => {
    if (allowed.has(f)) return false;
    if (/^\d+$/.test(f) && Number(f) <= 10) return false;
    return true;
  });
}

export async function validatePost(text: string, platform: Platform, brandId: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  if (!text.trim()) errors.push('Post text is empty');
  const len = visibleLength(text);
  if (len > LIMITS[platform]) errors.push(`${platformLabel(platform)} limit is ${LIMITS[platform]} characters (now ${len})`);
  const tags = text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const maxTags = MAX_HASHTAGS[platform];
  if (maxTags != null && tags > maxTags) errors.push(`${platformLabel(platform)} allows at most ${maxTags} hashtags (now ${tags})`);
  if (text.trim()) {
    const unknown = await unknownFacts(text, brandId);
    if (unknown.length) errors.push(`Numbers/prices not found in the brand knowledge base: ${unknown.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}
