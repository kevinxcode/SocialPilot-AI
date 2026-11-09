/**
 * Only ONE device may publish (otherwise two browsers could post the same thing twice).
 * - The device holding the lease runs the queue, autopilot, research and replies; the others only sync.
 * - The lease (15 min) is renewed at every tick AND right before every single post, so a long browser-automation run
 *   cannot outlive it unnoticed.
 * - Every write is compare-and-set (Firestore preconditions): two devices can never both win.
 * - Handover: "publish from this browser" only REQUESTS the lease; the current publisher releases it at its next check
 *   (between posts, never in the middle of one). If the publisher is offline, the lease simply expires.
 */
import { getSession, deviceId } from './config';
import { getMeta, setMeta } from './firestore';

export const LEASE_MS = 15 * 60_000;
const NAME = 'publisher';
const HANDOVER = 'handover';
const HANDOVER_TTL = 30 * 60_000;

export interface Lease {
  deviceId: string;
  label: string;
  until: number;
}

type MetaApi = { get: typeof getMeta; set: typeof setMeta };
const defaultApi: MetaApi = { get: getMeta, set: setMeta };
const myLabel = () => (typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) : 'device');

async function remember(ok: boolean, at: number) {
  await chrome.storage.local.set({ leaseLast: { ok, at } });
}

/**
 * True when this device may publish now (and renews its lease). Signed out (local mode) → always true.
 * On a cloud error the last answer is kept for less than one lease period (never two publishers).
 */
export async function holdsPublisherLease(now = Date.now(), api: MetaApi = defaultApi, label = myLabel()): Promise<boolean> {
  if (!(await getSession())) return true;
  const me = await deviceId();
  try {
    const cur = await api.get<Lease>(NAME);
    const mine = cur?.value?.deviceId === me && cur.value.until >= now;
    const free = !cur?.value || cur.value.until < now || mine;
    if (!free) {
      await remember(false, now);
      return false;
    }
    // Another device asked to take over: release (we are between posts right now) and stop publishing here.
    const h = (await api.get<{ to: string; at: number }>(HANDOVER))?.value;
    if (h && h.to !== me && now - h.at < HANDOVER_TTL) {
      if (mine) await api.set(NAME, { deviceId: me, label, until: 0 } satisfies Lease, cur!.updateTime);
      await remember(false, now);
      return false;
    }
    const ok = await api.set(NAME, { deviceId: me, label, until: now + LEASE_MS } satisfies Lease, cur ? cur.updateTime : null);
    await remember(ok, now);
    return ok;
  } catch {
    const last = (await chrome.storage.local.get('leaseLast')).leaseLast as { ok: boolean; at: number } | undefined;
    return !!last?.ok && now - last.at < LEASE_MS - 2 * 60_000;
  }
}

/**
 * Asks to make THIS browser the publisher. Takes effect immediately when nobody holds the lease, otherwise within a
 * few minutes (the current publisher hands over between posts).
 */
export async function takeOver(now = Date.now(), api: MetaApi = defaultApi): Promise<'now' | 'requested'> {
  const me = await deviceId();
  await api.set(HANDOVER, { to: me, at: now });
  const cur = await api.get<Lease>(NAME);
  if (!cur?.value || cur.value.until < now || cur.value.deviceId === me) {
    const ok = await api.set(NAME, { deviceId: me, label: myLabel(), until: now + LEASE_MS } satisfies Lease, cur ? cur.updateTime : null);
    if (ok) {
      await remember(true, now);
      return 'now';
    }
  }
  return 'requested';
}

export async function currentLease(api: Pick<MetaApi, 'get'> = defaultApi): Promise<Lease | null> {
  return (await api.get<Lease>(NAME))?.value ?? null;
}
