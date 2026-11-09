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

function waitComplete(tabId: number, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
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
  });
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

/** Puts the tab into a "SocialPilot" tab group so it sits apart from the user's tabs. */
async function groupTab(tabId: number): Promise<void> {
  try {
    if (!chrome.tabGroups) return;
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: 'SocialPilot', color: 'blue', collapsed: false });
  } catch {
    /* grouping is cosmetic */
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
      await chrome.tabs.update(tabId!, { url });
      await done;
      if (opts.focus) await chrome.tabs.update(tabId!, { active: true });
    } else {
      // A tab next to the user's tabs (not a popup window), opened in the background.
      const t = await chrome.tabs.create({ url, active: !!opts.focus });
      tabId = t.id;
      if (tabId == null) throw new Error('Could not open automation tab');
      await groupTab(tabId);
      await chrome.storage.session.set({ [KEY]: { windowId: t.windowId, tabId } });
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') await waitComplete(tabId);
    }
    await sleep(1500 + Math.random() * 1500); // let the SPA hydrate
    const ping = () => chrome.tabs.sendMessage(tabId!, { cmd: 'ping', __rpa: true });
    await chrome.scripting.executeScript({ target: { tabId: tabId! }, files: [contentScript] });
    try {
      await waitForContentScript(ping, 8_000);
    } catch {
      // The page may have navigated/reloaded during injection (SPA redirects): inject once more.
      if (tabId != null) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') await waitComplete(tabId, 30_000).catch(() => undefined);
      }
      await chrome.scripting.executeScript({ target: { tabId: tabId! }, files: [contentScript] });
      await waitForContentScript(ping, 12_000);
    }
    return tabId!;
  },

  async send<T>(tabId: number, msg: RpaCommand, timeoutMs = 150_000): Promise<T> {
    if (closedTabs.has(tabId)) throw new TabClosedError();
    let off = () => undefined as void;
    const closed = new Promise<T>((_r, rej) => {
      closeWaiters.set(tabId, () => rej(new TabClosedError()));
      off = () => void closeWaiters.delete(tabId);
    });
    return Promise.race([
      closed,
      chrome.tabs.sendMessage(tabId, { ...msg, __rpa: true }) as Promise<T>,
      new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('Automation step timed out')), timeoutMs)),
    ]).catch((e) => {
      // The message channel breaks when the tab goes away; report that as a user close.
      throw closedTabs.has(tabId) ? new TabClosedError() : e;
    }).finally(off);
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

let chain: Promise<unknown> = Promise.resolve();
/** Serializes RPA runs: only one automation at a time. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
