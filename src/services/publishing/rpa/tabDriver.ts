/**
 * Service-worker side: owns a dedicated background automation tab and talks to the RPA content script.
 * A normal (not minimized) window is used because background/minimized tabs throttle rendering.
 */
import contentScript from '@/content/rpa.ts?script';
import type { RpaCommand } from '../Publisher';
import { waitForContentScript } from './ready';

const KEY = 'rpaWindow';

async function getSession(): Promise<{ windowId?: number; tabId?: number }> {
  return ((await chrome.storage.session.get(KEY))[KEY] as { windowId?: number; tabId?: number }) ?? {};
}

async function tabAlive(tabId?: number): Promise<boolean> {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function waitComplete(tabId: number, timeoutMs = 45_000): Promise<void> & { cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timed out'));
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    cancel = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
  });
  // A navigation call can fail before its waiter is awaited.
  void promise.catch(() => undefined);
  return Object.assign(promise, { cancel: () => cancel() });
}

/** Thrown when the user closes the automation tab mid-run. */
export class TabClosedError extends Error {
  constructor() {
    super('Automation tab was closed');
    this.name = 'TabClosedError';
  }
}

let closingOurselves = false;
const closedTabs = new Set<number>();
const closeWaiters = new Map<number, () => void>();
chrome.tabs?.onRemoved?.addListener((id) => {
  if (closingOurselves) return;
  closedTabs.add(id);
  closeWaiters.get(id)?.();
});

/** Chrome refuses tab edits while the user drags a tab; wait and retry instead of failing the post. */
export async function retryTabEdit<T>(fn: () => Promise<T>, tries = 20, waitMs = 500): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/cannot be edited right now|dragging/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Puts the tab into a "SocialPilot" tab group so it sits apart from the user's tabs. */
async function groupTab(tabId: number): Promise<void> {
  try {
    if (!chrome.tabGroups) return;
    const groupId = await retryTabEdit(() => chrome.tabs.group({ tabIds: [tabId] }));
    await chrome.tabGroups.update(groupId, { title: 'SocialPilot', color: 'blue', collapsed: false });
  } catch {
    /* grouping is cosmetic */
  }
}

/**
 * The extension files on disk were rebuilt (new hashed file names) while this old worker is still running:
 * injection can never succeed, so reload the extension to pick up the new build.
 */
async function inject(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  } catch (e) {
    if (/Could not load file/i.test((e as Error).message)) {
      setTimeout(() => chrome.runtime.reload(), 500);
      throw new Error('Extension was updated on disk — reloading automatically, the post will be retried');
    }
    throw e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TabDriver = {
  /** Opens url in the automation window (creating it if needed) and injects the content script. */
  async open(url: string, opts: { focus?: boolean } = {}): Promise<number> {
    const s = await getSession();
    let tabId = s.tabId;
    if (tabId != null && closedTabs.has(tabId)) throw new TabClosedError();
    if (await tabAlive(tabId)) {
      const done = waitComplete(tabId!);
      try {
        await retryTabEdit(() => chrome.tabs.update(tabId!, { url }));
        await done;
      } finally {
        done.cancel();
      }
      if (opts.focus) await retryTabEdit(() => chrome.tabs.update(tabId!, { active: true }));
    } else {
      // A tab next to the user's tabs (not a popup window), opened in the background.
      const t = await retryTabEdit(() => chrome.tabs.create({ url, active: !!opts.focus }));
      tabId = t.id;
      if (tabId == null) throw new Error('Could not open automation tab');
      await groupTab(tabId);
      await chrome.storage.session.set({ [KEY]: { windowId: t.windowId, tabId } });
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') await waitComplete(tabId);
    }
    await sleep(1500 + Math.random() * 1500); // let the SPA hydrate
    const ping = () => chrome.tabs.sendMessage(tabId!, { cmd: 'ping', __rpa: true });
    await inject(tabId!);
    try {
      await waitForContentScript(ping, 8_000);
    } catch {
      // The page may have navigated/reloaded during injection (SPA redirects): inject once more.
      if (tabId != null) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') await waitComplete(tabId, 30_000).catch(() => undefined);
      }
      await inject(tabId!);
      await waitForContentScript(ping, 12_000);
    }
    return tabId!;
  },

  async send<T>(tabId: number, msg: RpaCommand, timeoutMs = 150_000): Promise<T> {
    try {
      return await sendOnce<T>(tabId, msg, timeoutMs);
    } catch (e) {
      // The page navigated mid-command (Facebook redirects), which kills the content script and its channel.
      // Read-only commands are safe to run again on the reloaded page; publish/reply never are.
      if (!CHANNEL_LOST.test((e as Error).message) || !READ_ONLY.has(msg.cmd)) {
        if (CHANNEL_LOST.test((e as Error).message)) throw new Error('The page reloaded or navigated during the step');
        throw e;
      }
      // The user may close the tab while we re-attach: report that as a cancel, not as Chrome's raw tab error.
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') await waitComplete(tabId, 30_000).catch(() => undefined);
        await sleep(1500);
        if (closedTabs.has(tabId)) throw new TabClosedError();
        await inject(tabId);
        await waitForContentScript(() => chrome.tabs.sendMessage(tabId, { cmd: 'ping', __rpa: true }), 12_000);
      } catch (e3) {
        throw closedTabs.has(tabId) ? new TabClosedError() : e3;
      }
      try {
        return await sendOnce<T>(tabId, msg, timeoutMs);
      } catch (e2) {
        if (CHANNEL_LOST.test((e2 as Error).message)) throw new Error('The page kept reloading during the step');
        throw e2;
      }
    }
  },

  async focus(tabId: number): Promise<void> {
    await retryTabEdit(() => chrome.tabs.update(tabId, { active: true }));
    await sleep(800);
  },

  async close(): Promise<void> {
    const s = await getSession();
    await chrome.storage.session.remove(KEY);
    if (s.tabId != null) {
      closingOurselves = true;
      await chrome.tabs.remove(s.tabId).catch(() => undefined);
      closingOurselves = false;
    }
  },
};

const CHANNEL_LOST = /message channel closed|Receiving end does not exist|message port closed/i;
const READ_ONLY = new Set<string>(['ping', 'preflight', 'findExisting', 'findReply', 'scrapeFeed', 'recentPosts', 'scrapeGroups']);

function sendOnce<T>(tabId: number, msg: RpaCommand, timeoutMs: number): Promise<T> {
  {
    if (closedTabs.has(tabId)) return Promise.reject(new TabClosedError());
    let off = () => undefined as void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<T>((_r, rej) => {
      closeWaiters.set(tabId, () => rej(new TabClosedError()));
      off = () => void closeWaiters.delete(tabId);
    });
    return Promise.race([
      closed,
      chrome.tabs.sendMessage(tabId, { ...msg, __rpa: true }) as Promise<T>,
      new Promise<T>((_r, rej) => { timer = setTimeout(() => rej(new Error('Automation step timed out')), timeoutMs); }),
    ]).catch((e) => {
      // The message channel breaks when the tab goes away; report that as a user close.
      throw closedTabs.has(tabId) ? new TabClosedError() : e;
    }).finally(() => { off(); clearTimeout(timer); });
  }
}

let chain: Promise<unknown> = Promise.resolve();
/** Serializes RPA runs: only one automation at a time. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
