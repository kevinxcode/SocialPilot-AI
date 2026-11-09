import { db } from '@/services/storage/db';
import type { Account, Platform, Post } from '@/types/models';
import type { Publisher, PublishResult } from '../Publisher';
import type { EngineResult, PreflightResult, ScrapedPost } from './engine';
import { TabDriver, exclusive } from './tabDriver';

const CONFIRM_WINDOW_MS = 90_000;

async function blobToDataUrl(b: Blob): Promise<string> {
  const buf = new Uint8Array(await new Response(b).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export interface Driver {
  open(url: string, opts?: { focus?: boolean }): Promise<number>;
  send<T>(tabId: number, msg: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export class RpaPublisher implements Publisher {
  constructor(
    public readonly platform: Platform,
    private driver: Driver = TabDriver as unknown as Driver,
    private confirmWindowMs = CONFIRM_WINDOW_MS,
  ) {}

  /** Where to post: the configured account/Page, or the post's Facebook Group (as a pseudo-account). */
  private async target(post?: Pick<Post, 'groupId'>): Promise<Account> {
    if (this.platform === 'fbgroup') {
      const g = post?.groupId ? await db.groups.get(post.groupId) : undefined;
      if (!g || !g.enabled) throw new Error('Facebook Group not found or disabled in Social Accounts');
      return { id: g.id, platform: 'fbgroup', name: g.name, profileUrl: g.url };
    }
    return this.account();
  }

  private async account(): Promise<Account> {
    const acc = await db.accounts.where('platform').equals(this.platform).first();
    if (!acc?.profileUrl) throw new Error(`No ${this.platform === 'threads' ? 'Threads account' : 'Facebook Page'} configured in Social Accounts`);
    return acc;
  }

  private async preflightOn(acc: Account): Promise<{ tabId: number; res: PreflightResult }> {
    let tabId = await this.driver.open(acc.profileUrl);
    let res = await this.driver.send<PreflightResult>(tabId, { cmd: 'preflight', platform: this.platform, account: { profileUrl: acc.profileUrl, pageName: acc.name } });
    if (res.switched) {
      tabId = await this.driver.open(acc.profileUrl);
      res = await this.driver.send<PreflightResult>(tabId, { cmd: 'preflight', platform: this.platform, account: { profileUrl: acc.profileUrl, pageName: acc.name } });
      if (res.switched) res = { ok: false, reason: 'Could not switch into the Facebook Page' };
    }
    return { tabId, res };
  }

  preflight(acc: Account): Promise<{ ok: boolean; reason?: string }> {
    return exclusive(async () => {
      try {
        const { res } = await this.preflightOn(acc);
        if (this.platform === 'fbgroup') await db.groups.update(acc.id, { lastCheckOk: res.ok, lastCheckMessage: res.reason ?? 'OK' });
        else await db.accounts.update(acc.id, { lastCheckOk: res.ok, lastCheckAt: Date.now(), lastCheckMessage: res.reason ?? 'OK' });
        return { ok: res.ok, reason: res.reason };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      } finally {
        await this.driver.close();
      }
    });
  }

  publish(post: Post, media: Blob[], opts: { dryRun?: boolean } = {}): Promise<PublishResult> {
    return exclusive(async () => {
      let keepOpen = false;
      let commandSent = false;
      try {
        const acc = await this.target(post);
        const pre = await this.preflightOn(acc);
        let tabId = pre.tabId;
        const res = pre.res;
        if (!res.ok) return { status: 'failed', reason: res.reason ?? 'Preflight failed' };
        if (this.platform === 'threads') {
          // Official compose intent: opens the composer directly, independent of where the "create" button sits.
          tabId = await this.driver.open(new URL('/intent/post', acc.profileUrl).toString());
        }
        const files = await Promise.all(
          media.map(async (b, i) => ({ name: `media-${i + 1}.${(b.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')}`, type: b.type, dataUrl: await blobToDataUrl(b) })),
        );
        commandSent = !opts.dryRun;
        const r = await this.driver.send<EngineResult>(tabId, {
          cmd: 'publish',
          platform: this.platform,
          input: { text: post.text, files, dryRun: !!opts.dryRun, pageName: acc.name, topic: this.platform === 'threads' ? post.topic : undefined },
        });
        if (r.status === 'dry-run') {
          keepOpen = true; // leave the filled composer for the user to inspect
          return { status: 'dry-run' };
        }
        if (r.status === 'failed') return { status: 'failed', reason: r.reason };
        if (r.status === 'clicked' && r.pending) return { status: 'published', note: 'Pending admin approval in the group' };
        // clicked or unknown: confirm on the feed before claiming success
        const found = await this.confirm(acc, post.fingerprint);
        if (found.found) return { status: 'published', url: found.url, ...(post.topic && r.status === 'clicked' && r.topicSet === false ? { note: `Topic "${post.topic}" could not be set (Threads UI)` } : {}) };
        return { status: 'unknown', reason: r.status === 'unknown' ? r.reason : 'Post not yet visible on the profile/page feed' };
      } catch (e) {
        // Before the publish command nothing can have been posted → failed.
        // After it, the outcome is ambiguous → unknown, and the queue checks the feed before any retry.
        const reason = (e as Error).message;
        if ((e as Error).name === 'TabClosedError') {
          return {
            status: 'cancelled',
            reason: commandSent
              ? 'Cancelled: you closed the SocialPilot tab. It may already have been posted — check your profile.'
              : 'Cancelled: you closed the SocialPilot tab before posting.',
          };
        }
        return commandSent ? { status: 'unknown', reason } : { status: 'failed', reason };
      } finally {
        if (!keepOpen) await this.driver.close();
      }
    });
  }

  private async confirm(acc: Account, fp: string): Promise<{ found: boolean; url?: string }> {
    const end = Date.now() + this.confirmWindowMs;
    do {
      const tabId = await this.driver.open(acc.profileUrl);
      const r = await this.driver.send<{ found: boolean; url?: string }>(tabId, { cmd: 'findExisting', platform: this.platform, fingerprint: fp });
      if (r.found) return r;
      if (Date.now() + 15_000 > end) break;
      await new Promise((res) => setTimeout(res, 15_000));
    } while (Date.now() < end);
    return { found: false };
  }

  findExisting(post: Pick<Post, 'fingerprint' | 'platform' | 'groupId'>): Promise<{ found: boolean; url?: string }> {
    return exclusive(async () => {
      try {
        const acc = await this.target(post);
        const tabId = await this.driver.open(acc.profileUrl);
        return await this.driver.send<{ found: boolean; url?: string }>(tabId, { cmd: 'findExisting', platform: this.platform, fingerprint: post.fingerprint });
      } finally {
        await this.driver.close();
      }
    });
  }
}

/** Opens a Threads search for each query and reads the top posts (read-only, never posts). */
export function scrapeThreadsSearch(queries: string[], perQuery = 8, driver: Driver = TabDriver as unknown as Driver): Promise<{ query: string; posts: ScrapedPost[] }[]> {
  return exclusive(async () => {
    const out: { query: string; posts: ScrapedPost[] }[] = [];
    try {
      for (const q of queries) {
        const tabId = await driver.open(`https://www.threads.com/search?q=${encodeURIComponent(q)}&serp_type=default`);
        const r = await driver.send<{ posts: ScrapedPost[] }>(tabId, { cmd: 'scrapeFeed', platform: 'threads', max: perQuery });
        out.push({ query: q, posts: r.posts ?? [] });
      }
    } finally {
      await driver.close();
    }
    return out;
  });
}

/** Reads the list of Facebook groups the logged-in user has joined (read-only). */
export function scrapeJoinedGroups(driver: Driver = TabDriver as unknown as Driver): Promise<{ name: string; url: string }[]> {
  return exclusive(async () => {
    try {
      const tabId = await driver.open('https://www.facebook.com/groups/joins/?nav_source=tab');
      const r = await driver.send<{ groups: { name: string; url: string }[] }>(tabId, { cmd: 'scrapeGroups', platform: 'fbgroup' }, 120_000);
      return r.groups ?? [];
    } finally {
      await driver.close();
    }
  });
}

export const publishers: Record<Platform, Publisher> = {
  threads: new RpaPublisher('threads'),
  facebook: new RpaPublisher('facebook'),
  fbgroup: new RpaPublisher('fbgroup'),
};
