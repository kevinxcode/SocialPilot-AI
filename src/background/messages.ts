import type { Platform } from '@/types/models';

/** Messages from extension pages/popup to the service worker. */
export type SwRequest =
  | { type: 'checkLogin'; platform: Platform }
  | { type: 'dryRun'; platform: Platform; text: string; mediaIds?: string[] }
  | { type: 'publishNow'; postId: string }
  | { type: 'tick' }
  | { type: 'replanAutopilot' }
  | { type: 'reviewDecision'; postId: string; approve: boolean };

export type SwResponse = { ok: boolean; message?: string; status?: string; url?: string };

export async function sendToSw(msg: SwRequest): Promise<SwResponse> {
  try {
    const r = (await chrome.runtime.sendMessage(msg)) as SwResponse | undefined;
    return r ?? { ok: false, message: 'No response from background service' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
