import type { Account, Platform, Post } from '@/types/models';

export type PublishResult =
  | { status: 'published'; url?: string; note?: string }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason?: string }
  | { status: 'dry-run'; note?: string }
  /** The user closed the automation tab: stop, do not retry. */
  | { status: 'cancelled'; reason: string };

export interface Publisher {
  platform: Platform;
  preflight(acc: Account): Promise<{ ok: boolean; reason?: string }>;
  publish(post: Post, media: Blob[], opts: { dryRun?: boolean }): Promise<PublishResult>;
  findExisting(post: Pick<Post, 'fingerprint' | 'platform' | 'groupId' | 'replyTo'>): Promise<{ found: boolean; url?: string; pending?: boolean }>;
}

/** Messages exchanged between service worker and the RPA content script. */
export type RpaCommand =
  | { cmd: 'ping' }
  | { cmd: 'reply'; input: import('./rpa/reply').ReplyInput }
  | { cmd: 'findReply'; targetUrl: string; profileUrl: string; fingerprint: string }
  | { cmd: 'preflight'; platform: Platform; account: { profileUrl: string; pageName?: string } }
  | { cmd: 'publish'; platform: Platform; input: { text: string; files: { name: string; type: string; dataUrl: string }[]; dryRun: boolean; pageName?: string; topic?: string } }
  /** since (Instagram): ignore posts older than this time (ms) */
  | { cmd: 'findExisting'; platform: Platform; fingerprint: string; since?: number }
  | { cmd: 'scrapeFeed'; platform: Platform; max: number }
  | { cmd: 'scrapeGroups'; platform: Platform }
  /** Instagram: links of the newest posts on the profile grid */
  | { cmd: 'recentPosts'; platform: Platform; max: number };
