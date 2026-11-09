import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { db, log } from '@/services/storage/db';
import { getSettings } from '@/services/storage/settings';
import { uid } from '@/lib/utils';
import type { Platform, QueueItem, Settings } from '@/types/models';
import { bestMinutes, slotMinutes } from './insights';

const PLANNED_KEY = 'autopilotPlanned';

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * Slots for one day (yyyy-MM-dd in the settings timezone): N posts spread evenly across the
 * window (centred in N equal segments). Facebook follows each Threads slot by the configured offset.
 */
export function planDay(date: string, s: Settings, best: number[] | null = null): QueueItem[] {
  const a = s.autopilot;
  if (!a.enabled || a.paused || a.postsPerDay < 1) return [];
  const start = toMinutes(a.windowStart);
  const end = Math.max(toMinutes(a.windowEnd), start + 1);
  const minutes = slotMinutes(a.postsPerDay, start, end, best);
  const dayIndex = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const types = a.contentTypes.length ? a.contentTypes : ['educational'];
  const out: QueueItem[] = [];
  for (let i = 0; i < a.postsPerDay; i++) {
    const minute = minutes[i];
    const hh = String(Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    const base = fromZonedTime(`${date}T${hh}:${mm}:00`, s.timezone).getTime();
    const contentType = types[(dayIndex * a.postsPerDay + i) % types.length];
    const slotKey = `${date}#${i}`;
    const platforms: [Platform, number][] = [
      ['threads', 0],
      ['facebook', a.platforms.threads ? a.facebookOffsetMinutes : 0],
    ];
    for (const [platform, offset] of platforms) {
      if (!a.platforms[platform]) continue;
      out.push({ id: uid(), kind: 'slot', platform, slotKey, contentType, runAt: base + offset * 60_000 });
    }
    // Facebook Groups: N per day, an hour after the first N slots (the runner picks a different group each time).
    if (a.platforms.fbgroup && i < Math.max(1, a.groupPostsPerDay ?? 1)) {
      out.push({ id: uid(), kind: 'slot', platform: 'fbgroup', slotKey: i === 0 ? `${date}#g` : `${date}#g${i}`, contentType, runAt: base + 60 * 60_000 });
    }
  }
  return out;
}

async function plannedDays(): Promise<string[]> {
  return ((await chrome.storage.local.get(PLANNED_KEY))[PLANNED_KEY] as string[] | undefined) ?? [];
}

/** Plans today and tomorrow once each; never creates slots already in the past. */
export async function ensurePlanned(now: number): Promise<number> {
  const s = await getSettings();
  if (!s.autopilot.enabled || s.autopilot.paused) return 0;
  const done = new Set(await plannedDays());
  const today = formatInTimeZone(now, s.timezone, 'yyyy-MM-dd');
  const tomorrow = formatInTimeZone(addDays(now, 1), s.timezone, 'yyyy-MM-dd');
  let added = 0;
  // Learned best hours (Threads engagement); null until there is enough data.
  const best =
    s.autopilot.bestTimes !== false
      ? bestMinutes(await db.posts.where('platform').equals('threads').toArray(), s.timezone, toMinutes(s.autopilot.windowStart), toMinutes(s.autopilot.windowEnd), now)
      : null;
  for (const day of [today, tomorrow]) {
    if (done.has(day)) continue;
    const slots = planDay(day, s, best).filter((q) => q.runAt > now);
    await db.transaction('rw', db.queue, async () => {
      for (const q of slots) {
        const exists = await db.queue
          .where('slotKey')
          .equals(q.slotKey!)
          .filter((x) => x.platform === q.platform)
          .count();
        if (!exists) {
          await db.queue.add(q);
          added++;
        }
      }
    });
    done.add(day);
  }
  await chrome.storage.local.set({ [PLANNED_KEY]: [...done].sort().slice(-7) });
  if (added) await log('info', 'autopilot', `Planned ${added} autopilot slot(s)`);
  return added;
}

/** Drops future autopilot slots and plans again (after settings change or pause/resume). */
export async function replan(now: number): Promise<void> {
  await db.queue
    .where('kind')
    .equals('slot')
    .filter((q) => q.runAt > now && !q.lockedUntil)
    .delete();
  await chrome.storage.local.set({ [PLANNED_KEY]: [] });
  await ensurePlanned(now);
}
