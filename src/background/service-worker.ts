import { IDEA_JOB_KEY, jobIsLive, runIdeaJob, type IdeaJob } from '@/services/content/ideasToQueue';
import { cleanGroupName } from '@/services/publishing/rpa/engine';
import { automaticComments } from '@/services/autopilot/comments';
import { uid } from '@/lib/utils';
import { formatInTimeZone } from 'date-fns-tz';
import { maybeDailyTrending, researchTrending } from '@/services/content/trending';
import { scrapeJoinedGroups, scrapeThreadsProfile, scrapeThreadsSearch } from '@/services/publishing/rpa/RpaPublisher';
import { refreshEngagement } from '@/services/analytics/engagement';
import { ownReplies } from '@/services/autopilot/ownReplies';
import { installSyncHooks, markSettingsDirty, syncNow } from '@/services/cloud/sync';
import { holdsPublisherLease } from '@/services/cloud/leader';
import { mediaBlob } from '@/services/cloud/drive';

installSyncHooks();
import { dailySummary } from '@/services/autopilot/insights';
/**
 * Service worker: owns alarms, the publishing queue, autopilot planning and RPA publishers.
 */
import { topicForPost } from '@/services/content/topics';
import { aiRouter } from '@/services/ai/AIRouter';
import { db, log, seedIfEmpty } from '@/services/storage/db';
import { removeDuplicates, repairOrphans, processDue, recoverOnStartup, schedulePost, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { publishers } from '@/services/publishing/rpa/RpaPublisher';
import { fingerprint } from '@/services/publishing/fingerprint';
import { autopilotHooks } from './autopilotHooks';
import { syncOllamaOriginRule } from './ollamaOrigin';
import { isTrustedSender } from './sender';
import { ModelRegistry } from '@/services/ai/ModelRegistry';
import { getSettings } from '@/services/storage/settings';
import type { SwRequest, SwResponse } from './messages';
import type { Post } from '@/types/models';

const TICK = 'queue-tick';

function notify(title: string, message: string, id?: string, buttons?: { title: string }[]) {
  chrome.notifications.create(id ?? `sp-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: message || ' ',
    ...(buttons ? { buttons, requireInteraction: true } : {}),
  });
}

async function loadMedia(ids: string[]): Promise<Blob[]> {
  const items = (await db.media.bulkGet(ids)).filter((m): m is NonNullable<typeof m> => !!m);
  // A file synced from another device is downloaded from Google Drive the first time it is needed.
  const blobs = await Promise.all(items.map((m) => mediaBlob(m)));
  return blobs.filter((b): b is Blob => !!b);
}

export const deps: QueueDeps = {
  publishers,
  notify: (t, m) => notify(t, m),
  loadMedia,
  runSlot: (item, now) => autopilotHooks.runSlot(item, now, { notify }),
  pickTopic: async (post) => ((await getSettings()).autoTopic ? topicForPost(post, aiRouter) : undefined),
};

/** Keeps the worker alive while a long RPA run is in progress. */
function keepAlive(): () => void {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => undefined), 20_000);
  return () => clearInterval(t);
}

/** Once a day, inside the autopilot window, after the queue is idle: trending research → ideas. */
async function dailyTrending() {
  const s = await getSettings();
  if (!s.trendingResearch || !s.autopilot.enabled || s.autopilot.paused) return;
  const now = Date.now();
  const hm = formatInTimeZone(now, s.timezone, 'HH:mm');
  if (hm < s.autopilot.windowStart || hm > s.autopilot.windowEnd) return;
  if (await db.queue.where('runAt').belowOrEqual(now).count()) return; // publishing first
  const brandId = s.activeBrandId ?? (await db.brands.toCollection().first())?.id;
  const b = brandId ? await db.brands.get(brandId) : undefined;
  if (!b) return;
  await maybeDailyTrending(formatInTimeZone(now, s.timezone, 'yyyy-MM-dd'), () =>
    researchTrending({ scrape: (q) => scrapeThreadsSearch(q), router: aiRouter }, { id: b.id, name: b.name, summary: `${b.industry}
${b.description}
Audience: ${b.audience}` }, now),
  );
}

const ENGAGEMENT_DAY_KEY = 'engagementLastRun';
/** Once a day, inside the autopilot window, when the queue is idle: read own Threads profile counters. */
async function dailyEngagement() {
  const s = await getSettings();
  if (s.autopilot.learnFromEngagement === false || !s.autopilot.enabled || s.autopilot.paused) return;
  const now = Date.now();
  const hm = formatInTimeZone(now, s.timezone, 'HH:mm');
  if (hm < s.autopilot.windowStart || hm > s.autopilot.windowEnd) return;
  if (await db.queue.where('runAt').belowOrEqual(now).count()) return; // publishing first
  const day = formatInTimeZone(now, s.timezone, 'yyyy-MM-dd');
  if ((await chrome.storage.local.get(ENGAGEMENT_DAY_KEY))[ENGAGEMENT_DAY_KEY] === day) return;
  const acc = await db.accounts.where('platform').equals('threads').first();
  if (!acc?.profileUrl) return;
  await chrome.storage.local.set({ [ENGAGEMENT_DAY_KEY]: day });
  await refreshEngagement(() => scrapeThreadsProfile(acc.profileUrl!), now);
}

const SUMMARY_DAY_KEY = 'summaryLastDay';
/** Once a day, after the autopilot window ends: a notification with the day's results. */
async function dailySummaryNotice() {
  const s = await getSettings();
  if (s.autopilot.dailySummary === false || !s.autopilot.enabled) return;
  const now = Date.now();
  if (formatInTimeZone(now, s.timezone, 'HH:mm') < s.autopilot.windowEnd) return;
  const day = formatInTimeZone(now, s.timezone, 'yyyy-MM-dd');
  if ((await chrome.storage.local.get(SUMMARY_DAY_KEY))[SUMMARY_DAY_KEY] === day) return;
  await chrome.storage.local.set({ [SUMMARY_DAY_KEY]: day });
  const sum = dailySummary(await db.posts.toArray(), day, s.timezone);
  if (sum) notify(sum.title, sum.message, 'summary');
}

let ticking: Promise<void> | null = null;
let tickStartedAt = 0;
/** A run that hangs (e.g. a stuck browser API call) must not block the queue forever. */
const TICK_STALE_MS = 12 * 60_000;
export function tick(): Promise<void> {
  if (ticking && Date.now() - tickStartedAt < TICK_STALE_MS) return ticking;
  if (ticking) void log('warn', 'scheduler', 'Previous queue run looked stuck — starting a new one');
  tickStartedAt = Date.now();
  const started = tickStartedAt;
  const stop = keepAlive();
  ticking = (async () => {
    try {
      // Cloud: sync first, then only the device holding the publisher lease posts (never two browsers at once).
      await syncNow();
      if (!(await holdsPublisherLease())) return;
      await autopilotHooks.ensurePlanned(Date.now());
      await removeDuplicates(Date.now());
      const fixed = await repairOrphans(Date.now());
      if (fixed) await log('warn', 'queue', `Re-queued ${fixed} scheduled posts that had lost their queue entry`);
      await processDue(Date.now(), deps);
      await automaticComments().catch((e: Error) => log('warn', 'comments', e.message));
      if (!(await db.queue.where('runAt').belowOrEqual(Date.now()).count()))
        await ownReplies(Date.now(), { router: aiRouter, scrape: (u) => scrapeThreadsProfile(u, 30) }).catch((e: Error) => log('warn', 'replies', e.message));
      await dailySummaryNotice().catch((e: Error) => log('warn', 'summary', e.message));
      await dailyTrending();
      await dailyEngagement().catch((e: Error) => log('warn', 'analytics', `Engagement refresh failed: ${e.message}`));
    } catch (e) {
      await log('error', 'scheduler', (e as Error).message);
    } finally {
      stop();
      if (tickStartedAt === started) ticking = null;
    }
  })();
  return ticking;
}

async function setup(startup: boolean) {
  await seedIfEmpty();
  await syncOllamaOriginRule((await getSettings()).providers.ollama.baseUrl).catch((e: Error) => log('warn', 'ollama', e.message));
  if (startup) await recoverOnStartup(Date.now());
  // First run: load local models so Ollama works without visiting AI Providers.
  await ModelRegistry.refresh('ollama').catch(() => undefined);
  const existing = await chrome.alarms.get(TICK);
  if (!existing) await chrome.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 0.1 });
  void tick();
}

chrome.runtime.onInstalled.addListener(() => void setup(true));
chrome.runtime.onStartup.addListener(() => void setup(true));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK) void tick();
});

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (id.startsWith('review:')) void autopilotHooks.reviewDecision(id.slice(7), idx === 0, { notify }).then(() => tick());
});

// Re-plan autopilot slots whenever its settings change (pause/resume, cadence, windows…).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  markSettingsDirty(changes.settings.newValue);
  type S = { providers?: { ollama?: { baseUrl?: string } } } | undefined;
  const oldHost = (changes.settings.oldValue as S)?.providers?.ollama?.baseUrl;
  const newHost = (changes.settings.newValue as S)?.providers?.ollama?.baseUrl;
  if (newHost && newHost !== oldHost) void syncOllamaOriginRule(newHost);
  const before = JSON.stringify((changes.settings.oldValue as { autopilot?: unknown } | undefined)?.autopilot ?? null);
  const after = JSON.stringify((changes.settings.newValue as { autopilot?: unknown } | undefined)?.autopilot ?? null);
  if (before !== after) void autopilotHooks.replan(Date.now());
});

async function handle(msg: SwRequest): Promise<SwResponse> {
  switch (msg.type) {
    case 'checkLogin': {
      const acc = await db.accounts.where('platform').equals(msg.platform).first();
      if (!acc) return { ok: false, message: 'Save the account first' };
      const r = await publishers[msg.platform].preflight(acc);
      return { ok: r.ok, message: r.ok ? 'Logged in as the configured account' : r.reason };
    }
    case 'checkGroup': {
      const g = await db.groups.get(msg.groupId);
      if (!g) return { ok: false, message: 'Group not found' };
      const r = await publishers.fbgroup.preflight({ id: g.id, platform: 'fbgroup', name: g.name, profileUrl: g.url });
      return { ok: r.ok, message: r.ok ? 'You can post in this group' : r.reason };
    }
    case 'dryRun': {
      const acc =
        msg.platform === 'fbgroup'
          ? msg.groupId
            ? { id: '' }
            : undefined
          : await db.accounts.where('platform').equals(msg.platform).first();
      if (!acc) return { ok: false, message: msg.platform === 'fbgroup' ? 'Pick a group first' : 'Save the account first' };
      const now = Date.now();
      const temp: Post = {
        id: 'dry-run',
        platform: msg.platform,
        accountId: acc.id,
        groupId: msg.groupId,
        text: msg.text,
        mediaIds: msg.mediaIds ?? [],
        status: 'processing',
        fingerprint: fingerprint(msg.text),
        source: 'manual',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (msg.platform === 'threads' && (await getSettings()).autoTopic) temp.topic = await topicForPost(temp, aiRouter).catch(() => undefined);
      const r = await publishers[msg.platform].publish(temp, await loadMedia(temp.mediaIds), { dryRun: true });
      await log('info', 'dry-run', `${msg.platform}: ${r.status}${'reason' in r && r.reason ? ` — ${r.reason}` : ''}`);
      return r.status === 'dry-run'
        ? { ok: true, message: `Composer filled, Post was NOT clicked. ${'note' in r && r.note ? `${r.note}. ` : ''}Check the automation tab, then close it.` }
        : { ok: false, message: 'reason' in r ? r.reason : r.status };
    }
    case 'publishNow': {
      await schedulePost(msg.postId, new Date(), { immediate: true });
      void tick();
      return { ok: true, message: 'Publishing started — you will get a notification' };
    }
    case 'queueIdeas': {
      const cur = (await chrome.storage.local.get(IDEA_JOB_KEY))[IDEA_JOB_KEY] as IdeaJob | undefined;
      if (jobIsLive(cur)) return { ok: false, message: 'A queue job is already running — wait, or press Stop' };
      const stop = keepAlive();
      void runIdeaJob(msg.ids, msg.platforms, msg.removeAfter, aiRouter)
        .then((j) => notify('Ideas queued', `Scheduled ${j.queued} posts${j.failed.length ? `, ${j.failed.length} failed` : ''}`))
        .catch((e: Error) => log('error', 'research', e.message))
        .finally(stop);
      return { ok: true, message: 'Started in the background' };
    }
    case 'stopIdeaJob': {
      const cur = (await chrome.storage.local.get(IDEA_JOB_KEY))[IDEA_JOB_KEY] as IdeaJob | undefined;
      if (cur) await chrome.storage.local.set({ [IDEA_JOB_KEY]: { ...cur, running: false, stopped: true, finishedAt: Date.now() } });
      return { ok: true };
    }
    case 'scanGroups': {
      try {
        const found = await scrapeJoinedGroups();
        // Tidy names saved by an earlier scan ("…Last active 3 days ago").
        for (const g of await db.groups.toArray()) {
          const n = cleanGroupName(g.name);
          if (n && n !== g.name) await db.groups.update(g.id, { name: n });
        }
        if (!found.length) return { ok: false, message: 'No groups found — are you logged in to Facebook and a member of any group?' };
        const existing = new Set((await db.groups.toArray()).map((g) => g.url.replace(/\/$/, '').toLowerCase()));
        const fresh = found.filter((g) => !existing.has(g.url.toLowerCase()));
        // Saved disabled: nothing is posted to a group until you switch it on.
        await db.groups.bulkAdd(fresh.map((g) => ({ id: uid(), name: g.name, url: g.url, rules: '', enabled: false })));
        return { ok: true, message: `Found ${found.length} joined groups, ${fresh.length} new saved (disabled — switch on the ones to post in).` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    case 'researchTrending': {
      const s = await getSettings();
      const brandId = s.activeBrandId ?? (await db.brands.toCollection().first())?.id;
      const b = brandId ? await db.brands.get(brandId) : undefined;
      if (!b) return { ok: false, message: 'Add a brand in Brand Knowledge first' };
      try {
        const ideas = await researchTrending({ scrape: (q) => scrapeThreadsSearch(q), router: aiRouter }, { id: b.id, name: b.name, summary: `${b.industry}
${b.description}
Audience: ${b.audience}` });
        return { ok: true, message: `${ideas.length} trending ideas saved (autopilot uses them next): ${ideas.map((i) => i.title).join(' · ')}` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    case 'tick':
      void tick();
      return { ok: true };
    case 'replanAutopilot':
      await autopilotHooks.replan(Date.now());
      return { ok: true };
    case 'reviewDecision':
      await autopilotHooks.reviewDecision(msg.postId, msg.approve, { notify });
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: SwRequest & { __rpa?: true }, sender, sendResponse) => {
  // RPA traffic goes SW → content script only; accept requests only from our own extension pages.
  if (msg?.__rpa || !isTrustedSender(sender, chrome.runtime.id, chrome.runtime.getURL(''))) return false;
  handle(msg)
    .then(sendResponse)
    .catch((e: Error) => sendResponse({ ok: false, message: e.message }));
  return true;
});
