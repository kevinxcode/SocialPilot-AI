import type { Platform } from '@/types/models';

/** Adds utm_source/medium/campaign to a link so visits from each platform can be counted. Null for an invalid URL. */
export function withUtm(url: string, source: Platform | string, campaign = 'autopilot'): string | null {
  try {
    const raw = url.trim();
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.searchParams.set('utm_source', String(source));
    u.searchParams.set('utm_medium', 'social');
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return null;
  }
}

/** Appends the link on its own paragraph unless it is already there or the post would exceed `limit` characters. */
export function appendLink(text: string, url: string, limit: number): string {
  if (text.includes(url)) return text;
  const next = `${text.trimEnd()}\n\n${url}`;
  return [...next].length <= limit ? next : text;
}
