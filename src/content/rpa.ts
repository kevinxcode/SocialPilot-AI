/** RPA content script — injected on demand by the service worker into the automation tab. */
import { runFindExisting, runPreflight, runPublish } from '@/services/publishing/rpa/engine';
import { FACEBOOK } from '@/services/publishing/rpa/selectors/facebook';
import { THREADS } from '@/services/publishing/rpa/selectors/threads';
import type { RpaCommand } from '@/services/publishing/Publisher';

const w = window as unknown as { __socialpilotRpa?: boolean };
if (!w.__socialpilotRpa) {
  w.__socialpilotRpa = true;
  chrome.runtime.onMessage.addListener((msg: RpaCommand & { __rpa?: true }, _sender, sendResponse) => {
    if (!msg?.__rpa) return false;
    const cfg = 'platform' in msg && msg.platform === 'facebook' ? FACEBOOK : THREADS;
    const run = async () => {
      switch (msg.cmd) {
        case 'ping':
          return { ok: true };
        case 'preflight':
          return runPreflight(cfg, msg.account);
        case 'publish':
          return runPublish(cfg, msg.input);
        case 'findExisting':
          return runFindExisting(cfg, msg.fingerprint);
      }
    };
    run()
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ status: 'failed', ok: false, reason: `Content script error: ${e.message}` }));
    return true; // async response
  });
}
