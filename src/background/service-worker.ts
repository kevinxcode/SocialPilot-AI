/**
 * Service worker: owns alarms, the publishing queue, autopilot planning and RPA publishers.
 */
import { db, log, seedIfEmpty } from '@/services/storage/db';
import { processDue, recoverOnStartup, schedulePost, type QueueDeps } from '@/services/publishing/PublishingQueue';
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
  const items = await db.media.bulkGet(ids);
  return items.filter((m): m is NonNullable<typeof m> => !!m).map((m) => m.blob);
}

export const deps: QueueDeps = {
  publishers,
  notify: (t, m) => notify(t, m),
  loadMedia,
  runSlot: (item, now) => autopilotHooks.runSlot(item, now, { notify }),
};

/** Keeps the worker alive while a long RPA run is in progress. */
function keepAlive(): () => void {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => undefined), 20_000);
  return () => clearInterval(t);
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
      await autopilotHooks.ensurePlanned(Date.now());
      await processDue(Date.now(), deps);
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
      const r = await publishers[msg.platform].publish(temp, await loadMedia(temp.mediaIds), { dryRun: true });
      await log('info', 'dry-run', `${msg.platform}: ${r.status}${'reason' in r && r.reason ? ` — ${r.reason}` : ''}`);
      return r.status === 'dry-run'
        ? { ok: true, message: 'Composer filled, Post was NOT clicked. Check the automation window, then close it.' }
        : { ok: false, message: 'reason' in r ? r.reason : r.status };
    }
    case 'publishNow': {
      await schedulePost(msg.postId, new Date(), { immediate: true });
      void tick();
      return { ok: true, message: 'Publishing started — you will get a notification' };
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
