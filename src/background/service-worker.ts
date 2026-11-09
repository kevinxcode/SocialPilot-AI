/**
 * Service worker: owns alarms, the publishing queue, autopilot planning and RPA publishers.
 */
import { db, log, seedIfEmpty } from '@/services/storage/db';
import { processDue, recoverOnStartup, schedulePost, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { publishers } from '@/services/publishing/rpa/RpaPublisher';
import { fingerprint } from '@/services/publishing/fingerprint';
import { autopilotHooks } from './autopilotHooks';
import { syncOllamaOriginRule } from './ollamaOrigin';
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
export function tick(): Promise<void> {
  if (ticking) return ticking;
  const stop = keepAlive();
  ticking = (async () => {
    try {
      await autopilotHooks.ensurePlanned(Date.now());
      await processDue(Date.now(), deps);
    } catch (e) {
      await log('error', 'scheduler', (e as Error).message);
    } finally {
      stop();
      ticking = null;
    }
  })();
  return ticking;
}

async function setup(startup: boolean) {
  await seedIfEmpty();
  await syncOllamaOriginRule((await getSettings()).providers.ollama.baseUrl).catch((e: Error) => log('warn', 'ollama', e.message));
  if (startup) await recoverOnStartup(Date.now());
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
    case 'dryRun': {
      const acc = await db.accounts.where('platform').equals(msg.platform).first();
      if (!acc) return { ok: false, message: 'Save the account first' };
      const now = Date.now();
      const temp: Post = {
        id: 'dry-run',
        platform: msg.platform,
        accountId: acc.id,
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
      await schedulePost(msg.postId, new Date());
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
  if (msg?.__rpa || sender.tab) return false; // RPA traffic is for content scripts
  handle(msg)
    .then(sendResponse)
    .catch((e: Error) => sendResponse({ ok: false, message: e.message }));
  return true;
});
