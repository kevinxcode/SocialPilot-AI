/** RPA content script — injected on demand by the service worker into the automation tab. */
import { runFindExisting, runPreflight, runPublish, runScrapeFeed, runScrapeGroups } from '@/services/publishing/rpa/engine';
import { FACEBOOK } from '@/services/publishing/rpa/selectors/facebook';
import { THREADS } from '@/services/publishing/rpa/selectors/threads';
import { FBGROUP } from '@/services/publishing/rpa/selectors/fbgroup';
import { INSTAGRAM } from '@/services/publishing/rpa/selectors/instagram';
import { runInstagramFindPost, runInstagramPreflight, runInstagramPublish, runInstagramRecent } from '@/services/publishing/rpa/instagram';
import type { RpaCommand } from '@/services/publishing/Publisher';
import { runReply, findReply } from '@/services/publishing/rpa/reply';

const w = window as unknown as { __socialpilotRpa?: boolean };
if (!w.__socialpilotRpa) {
  w.__socialpilotRpa = true;
  chrome.runtime.onMessage.addListener((msg: RpaCommand & { __rpa?: true }, _sender, sendResponse) => {
    if (!msg?.__rpa) return false;
    const p = 'platform' in msg ? msg.platform : 'threads';
    const cfg = p === 'facebook' ? FACEBOOK : p === 'fbgroup' ? FBGROUP : p === 'instagram' ? INSTAGRAM : THREADS;
    const ig = p === 'instagram';
    const run = async () => {
      switch (msg.cmd) {
        case 'reply':
          return runReply(msg.input);
        case 'findReply':
          return findReply(msg.targetUrl, msg.profileUrl, msg.fingerprint);
        case 'ping':
          return { ok: true };
        case 'preflight':
          return ig ? runInstagramPreflight(cfg, msg.account) : runPreflight(cfg, msg.account);
        case 'publish':
          return ig ? runInstagramPublish(cfg, msg.input) : runPublish(cfg, msg.input);
        case 'findExisting':
          return ig ? runInstagramFindPost(msg.fingerprint, msg.since) : runFindExisting(cfg, msg.fingerprint);
        case 'scrapeFeed':
          return runScrapeFeed(cfg, msg.max);
        case 'recentPosts':
          return runInstagramRecent(cfg, msg.max);
        case 'scrapeGroups':
          return runScrapeGroups();
      }
    };
    run()
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ status: 'failed', ok: false, reason: `Content script error: ${e.message}` }));
    return true; // async response
  });
}
