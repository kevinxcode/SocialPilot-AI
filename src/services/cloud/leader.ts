/**
 * Only ONE device may publish (otherwise two browsers would post the same thing twice).
 * The device holding the lease runs the queue, autopilot, research and replies; the others only sync and show data.
 * The lease lasts 10 minutes and is renewed every tick; if the publishing device goes offline, another takes over.
 * Writes use Firestore preconditions (compare-and-set), so two devices can never both win.
 */
import { getSession, deviceId } from './config';
import { getMeta, setMeta } from './firestore';

export const LEASE_MS = 10 * 60_000;
const NAME = 'publisher';

export interface Lease {
  deviceId: string;
  label: string;
  until: number;
}

type MetaApi = { get: typeof getMeta; set: typeof setMeta };

/**
 * True when this device may publish. Signed out (local mode) → always true.
 * On a cloud error the last known answer is kept for at most one lease period (never two publishers).
 */
export async function holdsPublisherLease(now = Date.now(), api: MetaApi = { get: getMeta, set: setMeta }, label = navigator.userAgent.slice(0, 80)): Promise<boolean> {
  if (!(await getSession())) return true;
  const me = await deviceId();
  try {
    const cur = await api.get<Lease>(NAME);
    const free = !cur || !cur.value || cur.value.until < now || cur.value.deviceId === me;
    if (!free) {
      await remember(false, now);
      return false;
    }
    const ok = await api.set(NAME, { deviceId: me, label, until: now + LEASE_MS } satisfies Lease, cur ? cur.updateTime : null);
    await remember(ok, now);
    return ok;
  } catch {
    const last = (await chrome.storage.local.get('leaseLast')).leaseLast as { ok: boolean; at: number } | undefined;
    return !!last?.ok && now - last.at < LEASE_MS - 60_000;
  }
}

async function remember(ok: boolean, at: number) {
  await chrome.storage.local.set({ leaseLast: { ok, at } });
}

/** Lets this device take over publishing now (e.g. the user picks it as the main device). */
export async function takeOver(now = Date.now(), api: MetaApi = { get: getMeta, set: setMeta }): Promise<void> {
  await api.set(NAME, { deviceId: await deviceId(), label: navigator.userAgent.slice(0, 80), until: now + LEASE_MS } satisfies Lease);
  await remember(true, now);
}

export async function currentLease(api: Pick<MetaApi, 'get'> = { get: getMeta }): Promise<Lease | null> {
  return (await api.get<Lease>(NAME))?.value ?? null;
}
