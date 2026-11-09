/**
 * Ollama rejects requests whose Origin is chrome-extension://… (403) unless OLLAMA_ORIGINS is set.
 * This dynamic DNR rule removes the Origin header — only for requests initiated by THIS extension
 * and only to the configured Ollama host — so local AI works without changing Ollama's config.
 */
export const OLLAMA_RULE_ID = 1001;

export function buildOllamaOriginRule(host: string, extensionId: string): chrome.declarativeNetRequest.Rule | null {
  let u: URL;
  try {
    u = new URL(host);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  return {
    id: OLLAMA_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      urlFilter: `|${u.protocol}//${u.host}/`,
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest', 'other'] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}

export async function syncOllamaOriginRule(host: string): Promise<void> {
  const rule = buildOllamaOriginRule(host, chrome.runtime.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OLLAMA_RULE_ID],
    addRules: rule ? [rule] : [],
  });
}
