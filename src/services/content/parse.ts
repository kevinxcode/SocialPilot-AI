import type { Platform } from '@/types/models';

export interface Variation {
  title: string;
  hook: string;
  caption: string;
  body: string;
  cta: string;
  hashtags: string[];
  suggestedTime: string;
  imagePrompt: string;
  platform: Platform;
}

/** Extracts the first JSON value from model output (fenced or bare, with surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const t = c.trim();
    try {
      return JSON.parse(t);
    } catch {
      /* try slicing */
    }
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
    ] as const) {
      const s = t.indexOf(open);
      const e = t.lastIndexOf(close);
      if (s >= 0 && e > s) {
        try {
          return JSON.parse(t.slice(s, e + 1));
        } catch {
          /* next */
        }
      }
    }
  }
  return undefined;
}

// Some models double-escape newlines in the JSON, leaving a literal backslash-n in the text: turn it back into a line break.
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/(?:\\r)?\\n/g, '\n').trim() : v == null ? '' : String(v));

export function normalizeHashtags(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(str) : str(v).split(/[,\s]+/);
  return [...new Set(list.map((h) => h.replace(/^#*/, '').trim()).filter(Boolean).map((h) => `#${h}`))];
}

export function parseVariations(text: string, platform: Platform): Variation[] {
  const j = extractJson(text) as { variations?: unknown[] } | unknown[] | undefined;
  const arr = Array.isArray(j) ? j : Array.isArray(j?.variations) ? j.variations : null;
  if (!arr || !arr.length) throw new Error('AI output could not be parsed as content variations. Try Regenerate or another model.');
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const caption = str(x.caption) || [str(x.hook), str(x.body), str(x.cta)].filter(Boolean).join('\n\n');
      return {
        title: str(x.title),
        hook: str(x.hook),
        caption,
        body: str(x.body),
        cta: str(x.cta),
        hashtags: normalizeHashtags(x.hashtags),
        suggestedTime: str(x.suggestedTime ?? x.suggested_time),
        imagePrompt: str(x.imagePrompt ?? x.image_prompt),
        platform,
      };
    })
    .filter((v) => v.caption);
}

export function parseIdeas(text: string): { title: string; body: string }[] {
  const j = extractJson(text) as { ideas?: unknown[] } | unknown[] | undefined;
  const arr = Array.isArray(j) ? j : Array.isArray(j?.ideas) ? j.ideas : null;
  if (!arr) throw new Error('AI output could not be parsed as a list of ideas.');
  return arr
    .map((x) =>
      typeof x === 'string' ? { title: x, body: '' } : { title: str((x as Record<string, unknown>).title), body: str((x as Record<string, unknown>).body) },
    )
    .filter((i) => i.title);
}
