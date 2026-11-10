import type { Platform } from '@/types/models';

const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|id|co\.id|net|org|app|io|me|ly|link)(?:\/\S*)?/gi;

/** Facebook Page / Group posts go out as text + image only: strip any URL and tidy the leftovers. */
export function stripLinks(text: string): string {
  return text
    .replace(URL_RE, '')
    .replace(/[ \t]+([.,!?])/g, '$1')
    .replace(/(?:di|at|kunjungi|visit|cek|klik|link)\s*[:：]?\s*$/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Facebook posts and Instagram captions go out without URLs (Instagram caption links are not clickable). */
export const noLinkPlatform = (p: Platform) => p === 'facebook' || p === 'fbgroup' || p === 'instagram';
