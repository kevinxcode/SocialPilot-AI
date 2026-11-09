/**
 * Service-worker side: owns a dedicated, unfocused automation window and talks to the RPA content script.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TabDriver = {
  /** Opens url in the automation window (creating it if needed) and injects the content script. */
  async open(url: string, opts: { focus?: boolean } = {}): Promise<number> {
    const s = await getSession();
    let tabId = s.tabId;
    if (await tabAlive(tabId)) {
      const done = waitComplete(tabId!);
      await chrome.tabs.update(tabId!, { url });
      await done;
      if (opts.focus) await chrome.windows.update(s.windowId!, { focused: true });
    } else {
      const win = await chrome.windows.create({ url, focused: !!opts.focus, type: 'normal', width: 1100, height: 900 });
      tabId = win.tabs?.[0]?.id;
      if (tabId == null) throw new Error('Could not open automation window');
      await chrome.storage.session.set({ [KEY]: { windowId: win.id, tabId } });
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
    return Promise.race([
      chrome.tabs.sendMessage(tabId, { ...msg, __rpa: true }) as Promise<T>,
      new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('Automation step timed out')), timeoutMs)),
    ]);
  },

  async close(): Promise<void> {
    const s = await getSession();
    await chrome.storage.session.remove(KEY);
    if (s.windowId != null) await chrome.windows.remove(s.windowId).catch(() => undefined);
  },
};

let chain: Promise<unknown> = Promise.resolve();
/** Serializes RPA runs: only one automation at a time. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
