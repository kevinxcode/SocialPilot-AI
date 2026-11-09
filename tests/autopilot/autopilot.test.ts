import { planDay, ensurePlanned } from '@/services/autopilot/planner';
import { runSlot, reviewDecision } from '@/services/autopilot/runner';
import { processDue } from '@/services/publishing/PublishingQueue';
import { db, resetDb, CUCIQU_SEED } from '@/services/storage/db';
import { getSettings, updateSettings } from '@/services/storage/settings';
import { RouterError } from '@/services/ai/AIRouter';
import type { QueueItem } from '@/types/models';

const MIN = 60_000;
const variation = (caption: string) => JSON.stringify({ variations: [{ title: 't', hook: '', body: '', cta: '', hashtags: [], caption, suggestedTime: '', imagePrompt: '' }] });
function router(texts: (string | Error)[]) {
  return {
    generate: vi.fn(async () => {
      const t = texts.length > 1 ? texts.shift()! : texts[0];
      if (t instanceof Error) throw t;
      return { text: t, providerId: 'ollama' as const, modelId: 'qwen3:8b' };
    }),
  };
}
let notes: string[];
const ctx = (r: ReturnType<typeof router>) => ({ notify: (t: string, m: string) => notes.push(`${t}: ${m}`), router: r });

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  notes = [];
  await db.brands.add({ ...CUCIQU_SEED, id: 'b1', createdAt: 0, updatedAt: 0 });
  await db.accounts.bulkAdd([
    { id: 'at', platform: 'threads', name: 'cuciqu.pro', profileUrl: 'https://www.threads.com/@cuciqu.pro' },
    { id: 'af', platform: 'facebook', name: 'CuciQu Pro', profileUrl: 'https://www.facebook.com/cuciqupro' },
  ]);
  await updateSettings({ autopilot: { enabled: true, postsPerDay: 2, windowStart: '09:00', windowEnd: '19:00' } });
});

test('2 posts/day → 2 Threads + 2 Facebook slots at expected Jakarta times (Facebook +30 min)', async () => {
  const slots = planDay('2026-11-10', await getSettings());
  const t = slots.filter((s) => s.platform === 'threads').map((s) => new Date(s.runAt).toISOString());
  const f = slots.filter((s) => s.platform === 'facebook').map((s) => new Date(s.runAt).toISOString());
  expect(t).toEqual(['2026-11-10T04:30:00.000Z', '2026-11-10T09:30:00.000Z']); // 11:30 & 16:30 WIB
  expect(f).toEqual(['2026-11-10T05:00:00.000Z', '2026-11-10T10:00:00.000Z']);
  expect(new Set(slots.map((s) => s.slotKey))).toEqual(new Set(['2026-11-10#0', '2026-11-10#1']));
  expect(slots.every((s) => s.kind === 'slot' && s.contentType)).toBe(true);
});

test('paused or disabled autopilot plans nothing', async () => {
  await updateSettings({ autopilot: { paused: true } });
  expect(planDay('2026-11-10', await getSettings())).toEqual([]);
  await ensurePlanned(Date.parse('2026-11-10T00:00:00Z'));
  expect(await db.queue.count()).toBe(0);
});

test('ensurePlanned is idempotent and never creates slots in the past', async () => {
  const now = Date.parse('2026-11-10T06:00:00Z'); // 13:00 WIB — first Threads/Facebook slot already passed
  await ensurePlanned(now);
  await ensurePlanned(now);
  const q = await db.queue.toArray();
  expect(q.every((s) => s.runAt > now)).toBe(true);
  // today: 1 threads + 1 facebook remaining; tomorrow: 2 + 2
  expect(q.length).toBe(6);
});

const slot = (platform: 'threads' | 'facebook' = 'threads'): QueueItem => ({
  id: 'q1', kind: 'slot', platform, slotKey: '2026-11-10#0', contentType: 'educational', runAt: Date.parse('2026-11-10T04:30:00Z'),
});

test('valid generation → autopilot post scheduled now, slot removed', async () => {
  await db.queue.add(slot());
  const r = router([variation('Cucian tertukar bikin pusing? CuciQu Pro bantu catat setiap pesanan. #laundry')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const posts = await db.posts.toArray();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ source: 'autopilot', status: 'scheduled', platform: 'threads', brandId: 'b1', providerId: 'ollama' });
  expect(await db.queue.where('kind').equals('slot').count()).toBe(0);
  expect(await db.queue.where('postId').equals(posts[0].id).count()).toBe(1);
  expect((r.generate.mock.calls[0] as unknown[])[0]).toMatchObject({ purpose: 'autopilot' });
});

test('unknown price twice → slot skipped, nothing published or scheduled', async () => {
  await db.queue.add(slot());
  const r = router([variation('Promo cuma Rp 49.000 sebulan!')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(r.generate).toHaveBeenCalledTimes(2);
  expect(await db.posts.count()).toBe(0);
  expect(await db.queue.count()).toBe(0);
  expect(notes.join()).toMatch(/skipped/i);
});

test('invalid first draft is regenerated once with the errors, then accepted', async () => {
  await db.queue.add(slot());
  const r = router([variation('Diskon 50% hari ini!'), variation('Kelola laundry lebih rapi dengan CuciQu Pro.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(r.generate).toHaveBeenCalledTimes(2);
  const second = (r.generate.mock.calls[1] as unknown[])[0] as { messages: { content: string }[] };
  expect(second.messages[1].content).toMatch(/50%/);
  expect(await db.posts.count()).toBe(1);
});

test('router refusing paid model → slot skipped with notification, no fallback', async () => {
  await db.queue.add(slot());
  const r = router([new RouterError('NO_ELIGIBLE', [{ providerId: 'openrouter', outcome: 'skipped', reason: 'paid model not allowed' }])]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(await db.posts.count()).toBe(0);
  expect(notes.join()).toMatch(/paid model not allowed/);
});

test('paused at slot time → slot dropped without generating', async () => {
  await db.queue.add(slot());
  await updateSettings({ autopilot: { paused: true } });
  const r = router([variation('x')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(r.generate).not.toHaveBeenCalled();
  expect(await db.queue.count()).toBe(0);
});

test('review window: post held, approve schedules it now, reject cancels', async () => {
  await updateSettings({ autopilot: { reviewWindowMinutes: 15 } });
  await db.queue.add(slot());
  const r = router([variation('Kelola laundry lebih rapi dengan CuciQu Pro.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const p = (await db.posts.toArray())[0];
  expect(p.scheduledAt).toBe(slot().runAt + 15 * MIN);
  expect(notes.join()).toMatch(/review/i);
  await reviewDecision(p.id, false, ctx(r));
  expect((await db.posts.get(p.id))?.status).toBe('cancelled');
});

test('missed autopilot slots after sleep: only the latest per platform runs', async () => {
  const base = Date.parse('2026-11-10T04:30:00Z');
  await db.queue.bulkAdd([
    { id: 's0', kind: 'slot', platform: 'threads', slotKey: 'd#0', contentType: 'tips', runAt: base },
    { id: 's1', kind: 'slot', platform: 'threads', slotKey: 'd#1', contentType: 'tips', runAt: base + 60 * MIN },
  ]);
  const ran: string[] = [];
  await processDue(base + 90 * MIN, {
    publishers: {} as never,
    notify: () => undefined,
    loadMedia: async () => [],
    runSlot: async (item) => {
      ran.push(item.id);
      await db.queue.delete(item.id);
    },
  });
  expect(ran).toEqual(['s1']);
  expect(await db.queue.count()).toBe(0);
});

test('planDay schedules N Facebook Group slots per day', async () => {
  const { getSettings: gs } = await import('@/services/storage/settings');
  const s = await gs();
  const plan = planDay('2026-11-10', { ...s, autopilot: { ...s.autopilot, enabled: true, postsPerDay: 4, groupPostsPerDay: 3, platforms: { threads: true, facebook: false, fbgroup: true } } });
  const groups = plan.filter((q) => q.platform === 'fbgroup');
  expect(groups).toHaveLength(3);
  expect(new Set(groups.map((g) => g.slotKey)).size).toBe(3);
});
