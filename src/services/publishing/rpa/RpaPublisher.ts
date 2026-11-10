import { noLinkPlatform, stripLinks } from '@/services/content/noLinks';
import { db, log } from '@/services/storage/db';
import type { Account, Platform, Post } from '@/types/models';
import type { Publisher, PublishResult } from '../Publisher';
import type { EngineResult, PreflightResult, ScrapedPost } from './engine';
import { TabDriver, exclusive } from './tabDriver';
import { canonicalThreadUrl } from '@/services/content/comments';

const CONFIRM_WINDOW_MS = 90_000;

/** The post's account/group is gone or disabled: retrying cannot help until the user fixes Social Accounts. */
export class TargetMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetMissingError';
  }
}
/** How many of the newest Instagram posts are opened to look for ours. */
const INSTAGRAM_RECENT_CHECK = 6;

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
  /** bring the automation tab to the front (Facebook's composer does not open in a throttled background tab) */
  focus?(tabId: number): Promise<void>;
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
      if (!g || !g.enabled) throw new TargetMissingError('Facebook Group not found or disabled in Social Accounts');
      return { id: g.id, platform: 'fbgroup', name: g.name, profileUrl: g.url };
    }
    return this.account();
  }

  private async account(): Promise<Account> {
    const acc = await db.accounts.where('platform').equals(this.platform).first();
    const what = this.platform === 'threads' ? 'Threads account' : this.platform === 'instagram' ? 'Instagram account' : 'Facebook Page';
    if (!acc?.profileUrl) throw new Error(`No ${what} configured in Social Accounts`);
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
        // Instagram cannot post text only: refuse before opening anything.
        if (this.platform === 'instagram' && media.length === 0) return { status: 'failed', reason: 'Instagram posts need an image or video — add one from the Media Library' };
        if (this.platform === 'instagram' && post.replyTo) return { status: 'failed', reason: 'Replies are not supported on Instagram' };
        const acc = await this.target(post);
        if (post.replyTo && acc.id !== post.accountId) return { status: 'failed', reason: 'Reply account changed; skipped' };
        const startedAt = Date.now(); // our post cannot be older than this
        const pre = await this.preflightOn(acc);
        let tabId = pre.tabId;
        const res = pre.res;
        if (!res.ok) return { status: 'failed', reason: res.reason ?? 'Preflight failed' };
        if (post.replyTo) {
          const target = canonicalThreadUrl(post.replyTo);
          if (this.platform !== 'threads' || !target || !post.replyTargetText) return { status: 'failed', reason: 'Invalid reply target' };
          tabId = await this.driver.open(target, { focus: true });
        } else if (this.platform === 'threads') {
          // Official compose intent: opens the composer directly, independent of where the "create" button sits.
          tabId = await this.driver.open(new URL('/intent/post', acc.profileUrl).toString());
        }
        const files = await Promise.all(
          media.map(async (b, i) => ({ name: `media-${i + 1}.${(b.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')}`, type: b.type, dataUrl: await blobToDataUrl(b) })),
        );
        if (this.platform !== 'threads') await this.driver.focus?.(tabId);
        commandSent = !opts.dryRun;
        const r = await this.driver.send<EngineResult>(tabId, post.replyTo ? {
          cmd: 'reply',
          input: { targetUrl: post.replyTo, targetText: post.replyTargetText!, text: post.text, dryRun: !!opts.dryRun },
        } : {
          cmd: 'publish',
          platform: this.platform,
          input: { text: noLinkPlatform(this.platform) ? stripLinks(post.text) : post.text, files, dryRun: !!opts.dryRun, pageName: acc.name, topic: this.platform === 'threads' ? post.topic : undefined },
        });
        if (r.status === 'dry-run') {
          keepOpen = true; // leave the filled composer for the user to inspect
          if (r.note) return { status: 'dry-run', note: r.note };
          return { status: 'dry-run', note: post.topic ? (r.topicIssue ? `Topic "${post.topic}" not set: ${r.topicIssue}` : `Topic "${post.topic}" set`) : 'No topic chosen' };
        }
        if (r.status === 'failed') return { status: 'failed', reason: r.reason };
        // Evidence written immediately after Share (survives a closed tab during the profile check).
        if (r.status === 'clicked' && r.note) await log('info', 'publish', `${this.platform} ${post.id}: shared — ${r.note}`).catch(() => undefined);
        if (r.status === 'clicked' && r.pending) return { status: 'published', note: 'Pending admin approval in the group' };
        // clicked or unknown: confirm on the feed before claiming success
        const found = post.replyTo
          ? await this.driver.send<{ found: boolean; url?: string }>(tabId, { cmd: 'findReply', targetUrl: post.replyTo, profileUrl: acc.profileUrl, fingerprint: post.fingerprint })
          : await this.confirm(acc, post.fingerprint, startedAt);
        if (found.found && 'pending' in found && found.pending) return { status: 'published', note: 'Pending admin approval in the group' };
        if (found.found && r.status === 'clicked' && r.note) return { status: 'published', url: found.url, note: r.note };
        if (found.found) return { status: 'published', url: found.url, ...(post.topic && r.status === 'clicked' && r.topicSet === false ? { note: `Topic "${post.topic}" not set: ${r.topicIssue ?? 'Threads UI'}` } : {}) };
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

  /**
   * Feed check. Groups: besides the group feed, "Your content" in the group is checked —
   * Pending (waiting for admin approval) and Published (approved; in a busy group it may be far down the feed).
   * Found in either one counts as success.
   */
  private async lookFor(acc: Account, fp: string, since?: number): Promise<{ found: boolean; url?: string; pending?: boolean }> {
    if (this.platform === 'instagram') return this.lookForInstagram(acc, fp, since);
    const tabId = await this.driver.open(acc.profileUrl);
    const r = await this.driver.send<{ found: boolean; url?: string }>(tabId, { cmd: 'findExisting', platform: this.platform, fingerprint: fp });
    if (r.found || this.platform !== 'fbgroup') return r;
    const base = acc.profileUrl.replace(/\/$/, '');
    const pendingTab = await this.driver.open(`${base}/my_pending_content`);
    const p = await this.driver.send<{ found: boolean; url?: string }>(pendingTab, { cmd: 'findExisting', platform: this.platform, fingerprint: fp });
    if (p.found) return { found: true, pending: true };
    const postedTab = await this.driver.open(`${base}/my_posted_content`);
    const done = await this.driver.send<{ found: boolean; url?: string }>(postedTab, { cmd: 'findExisting', platform: this.platform, fingerprint: fp });
    return done.found ? { found: true, url: done.url } : { found: false };
  }

  /**
   * Instagram's profile grid shows only images, so the newest posts are opened one by one and their caption is
   * compared with the post's fingerprint.
   */
  private async lookForInstagram(acc: Account, fp: string, since?: number, newest = INSTAGRAM_RECENT_CHECK): Promise<{ found: boolean; url?: string }> {
    const tabId = await this.driver.open(acc.profileUrl);
    const { urls } = await this.driver.send<{ urls: string[] }>(tabId, { cmd: 'recentPosts', platform: 'instagram', max: newest });
    for (const url of urls ?? []) {
      const postTab = await this.driver.open(url);
      const r = await this.driver.send<{ found: boolean }>(postTab, { cmd: 'findExisting', platform: 'instagram', fingerprint: fp, since });
      if (r.found) return { found: true, url };
    }
    return { found: false };
  }

  private async confirm(acc: Account, fp: string, since?: number): Promise<{ found: boolean; url?: string; pending?: boolean }> {
    const end = Date.now() + this.confirmWindowMs;
    do {
      const r = await this.lookFor(acc, fp, since);
      if (r.found) return r;
      if (Date.now() + 15_000 > end) break;
      await new Promise((res) => setTimeout(res, 15_000));
    } while (Date.now() < end);
    return { found: false };
  }

  findExisting(post: Pick<Post, 'fingerprint' | 'platform' | 'groupId' | 'replyTo'>): Promise<{ found: boolean; url?: string }> {
    return exclusive(async () => {
      try {
        const acc = await this.target(post);
        if (post.replyTo && !canonicalThreadUrl(post.replyTo)) throw new Error('Invalid reply target');
        if (post.replyTo) {
          const tabId = await this.driver.open(post.replyTo);
          return await this.driver.send<{ found: boolean; url?: string }>(tabId, {
            cmd: 'findReply', targetUrl: post.replyTo, profileUrl: acc.profileUrl, fingerprint: post.fingerprint,
          });
        }
        return await this.lookFor(acc, post.fingerprint);
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

/** Reads the brand's own Threads profile posts with their counters (read-only, never posts). */
export function scrapeThreadsProfile(profileUrl: string, max = 25, driver: Driver = TabDriver as unknown as Driver): Promise<ScrapedPost[]> {
  return exclusive(async () => {
    try {
      const tabId = await driver.open(profileUrl);
      const r = await driver.send<{ posts: ScrapedPost[] }>(tabId, { cmd: 'scrapeFeed', platform: 'threads', max });
      return r.posts ?? [];
    } finally {
      await driver.close();
    }
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
  instagram: new RpaPublisher('instagram'),
};
