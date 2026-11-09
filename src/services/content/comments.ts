import { z } from 'zod';

/** Only navigate to a concrete Threads post selected from the crawler results. */
export function canonicalThreadUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^(www\.)?threads\.(com|net)$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);
    return m ? `https://www.threads.com/@${m[1].toLowerCase()}/post/${m[2]}` : null;
  } catch {
    return null;
  }
}

const decisionSchema = z.object({
  relevant: z.literal(true),
  confidence: z.number().min(0.9).max(1),
  comment: z.string().trim().min(15).max(400),
});

export function parseCommentDecision(raw: string): string | null {
  try {
    const parsed = decisionSchema.safeParse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()));
    if (!parsed.success) return null;
    const text = parsed.data.comment;
    if (/https?:|www\.|[@#]|<[^>]+>/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}
