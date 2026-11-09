/** Accept messages only from this extension's own pages (dashboard tab, popup) — never from content scripts or other extensions. */
export function isTrustedSender(sender: chrome.runtime.MessageSender, runtimeId: string, baseUrl: string): boolean {
  return sender.id === runtimeId && !!sender.url && sender.url.startsWith(baseUrl);
}
