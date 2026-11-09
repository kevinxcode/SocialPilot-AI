/* Minimal in-memory chrome.* mock for unit tests. */
export function installChromeMock(): void {
  const store: Record<string, unknown> = {};
  const g = globalThis as unknown as { chrome: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          if (keys == null) return { ...store };
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (items: Record<string, unknown>) => { Object.assign(store, structuredClone(items)); },
        remove: async (k: string) => { delete store[k]; },
        clear: async () => { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    notifications: { create: () => {} },
    runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => {} }, getURL: (p: string) => p },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
}
