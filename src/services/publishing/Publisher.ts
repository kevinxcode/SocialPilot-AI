import type { Account, Platform, Post } from '@/types/models';

export type PublishResult =
  | { status: 'published'; url?: string; note?: string }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason?: string }
  | { status: 'dry-run' }
  /** The user closed the automation tab: stop, do not retry. */
  | { status: 'cancelled'; reason: string };

export interface Publisher {
  platform: Platform;
  preflight(acc: Account): Promise<{ ok: boolean; reason?: string }>;
  publish(post: Post, media: Blob[], opts: { dryRun?: boolean }): Promise<PublishResult>;
  findExisting(post: Pick<Post, 'fingerprint' | 'platform' | 'groupId'>): Promise<{ found: boolean; url?: string }>;
}

/** Messages exchanged between service worker and the RPA content script. */
export type RpaCommand =
  | { cmd: 'ping' }
  | { cmd: 'preflight'; platform: Platform; account: { profileUrl: string; pageName?: string } }
  | { cmd: 'publish'; platform: Platform; input: { text: string; files: { name: string; type: string; dataUrl: string }[]; dryRun: boolean; pageName?: string; topic?: string } }
  | { cmd: 'findExisting'; platform: Platform; fingerprint: string };
