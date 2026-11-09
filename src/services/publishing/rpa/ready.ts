/**
 * The injected loader imports the real content script asynchronously, so its message listener
 * appears a moment after executeScript resolves. Ping until it answers.
 */
export async function waitForContentScript(ping: () => Promise<unknown>, timeoutMs = 15_000, intervalMs = 250): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const r = (await ping()) as { ok?: boolean } | undefined;
      if (r?.ok) return;
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() >= end) throw new Error(`Automation script did not start on the page${last ? ` (${last})` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
