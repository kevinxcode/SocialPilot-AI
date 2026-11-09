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
  const r = router([variation('Cucian tertukar bikin pusing? CuciQu Pro bantu catat setiap pesanan dengan rapi, jadi pelanggan tidak perlu menunggu lama dan kamu bisa fokus. #laundry')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const posts = await db.posts.toArray();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ source: 'autopilot', status: 'scheduled', platform: 'threads', brandId: 'b1', providerId: 'ollama' });
  expect(await db.queue.where('kind').equals('slot').count()).toBe(0);
  expect(await db.queue.where('postId').equals(posts[0].id).count()).toBe(1);
  expect((r.generate.mock.calls[0] as unknown[])[0]).toMatchObject({ purpose: 'autopilot' });
});

test('unknown price on every draft → slot skipped, nothing published or scheduled', async () => {
  await db.queue.add(slot());
  const r = router([variation('Promo cuma Rp 49.000 sebulan untuk kamu yang ingin laundry lebih rapi dan tidak ada nota yang hilang lagi!')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(r.generate).toHaveBeenCalledTimes(3);
  expect(await db.posts.count()).toBe(0);
  expect(await db.queue.count()).toBe(0);
  expect(notes.join()).toMatch(/skipped/i);
});

test('invalid first draft is regenerated once with the errors, then accepted', async () => {
  await db.queue.add(slot());
  const r = router([variation('Diskon 50% hari ini!'), variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
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
  const r = router([variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const p = (await db.posts.toArray())[0];
  expect(p.scheduledAt).toBe(slot().runAt + 15 * MIN);
  expect(notes.join()).toMatch(/review/i);
  await reviewDecision(p.id, false, ctx(r));
  expect((await db.posts.get(p.id))?.status).toBe('cancelled');
});

test('missed autopilot slots after sleep: the latest runs now, the earlier one is carried over', async () => {
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
  const left = await db.queue.toArray();
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ id: 's0', slotKey: expect.stringMatching(/#c0$/) });
});

test('planDay schedules N Facebook Group slots per day', async () => {
  const { getSettings: gs } = await import('@/services/storage/settings');
  const s = await gs();
  const plan = planDay('2026-11-10', { ...s, autopilot: { ...s.autopilot, enabled: true, postsPerDay: 4, groupPostsPerDay: 3, platforms: { threads: true, facebook: false, fbgroup: true } } });
  const groups = plan.filter((q) => q.platform === 'fbgroup');
  expect(groups).toHaveLength(3);
  expect(new Set(groups.map((g) => g.slotKey)).size).toBe(3);
});

test('broken AI output (raw JSON / too short) is regenerated with the problem named', async () => {
  await db.queue.add(slot());
  const r = router([variation('Halo!'), variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  expect(r.generate).toHaveBeenCalledTimes(2);
  const second = (r.generate.mock.calls[1] as unknown[])[0] as { messages: { content: string }[] };
  expect(second.messages[1].content).toMatch(/too short/);
  expect(await db.posts.count()).toBe(1);
});

test('Threads autopilot post gets the brand website with UTM; the brand CTA is in the prompt', async () => {
  const b = (await db.brands.toArray())[0];
  await db.brands.update(b.id, { website: 'cuciqu.com', cta: 'Coba gratis 14 hari' });
  await db.queue.add(slot());
  const r = router([variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const p = (await db.posts.toArray())[0];
  expect(p.text).toMatch(/https:\/\/cuciqu\.com\/\?utm_source=threads&utm_medium=social&utm_campaign=autopilot$/);
  const prompt = ((r.generate.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] }).messages[1].content;
  expect(prompt).toMatch(/Coba gratis 14 hari/);
});

test('best-performing Threads posts are fed into the next prompt', async () => {
  await db.posts.add({
    id: 'old', platform: 'threads', accountId: 'a', text: 'Nota hilang? Ini cara simpel mencatat order', mediaIds: [], status: 'published', fingerprint: 'old',
    source: 'autopilot', attempts: 1, createdAt: 0, updatedAt: 0, publishedAt: slot().runAt - 86_400_000, engagement: 42,
  });
  await db.queue.add(slot());
  const r = router([variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const prompt = ((r.generate.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] }).messages[1].content;
  expect(prompt).toMatch(/engagement 42\] Nota hilang/);
});

test('no trending idea → a proven old winner is rewritten with a new angle and marked recycled', async () => {
  await db.posts.add({
    id: 'win', platform: 'threads', accountId: 'at', text: 'Nota hilang? Ini cara simpel mencatat order https://cuciqu.com/?utm_source=threads', mediaIds: [], status: 'published', fingerprint: 'win',
    source: 'autopilot', attempts: 1, createdAt: 0, updatedAt: 0, publishedAt: slot().runAt - 40 * 86_400_000, engagement: 25,
  });
  await db.queue.add(slot());
  const r = router([variation('Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.')]);
  await runSlot(slot(), slot().runAt, ctx(r));
  const prompt = ((r.generate.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] }).messages[1].content;
  expect(prompt).toMatch(/fresh angle/);
  expect(prompt).toMatch(/Nota hilang\? Ini cara simpel/);
  expect(prompt).not.toMatch(/utm_source/);
  expect((await db.posts.get('win'))?.recycledAt).toBe(slot().runAt);
});

test('Threads and Facebook of the same slot recycle the same winner', async () => {
  const old = slot().runAt - 40 * 86_400_000;
  await db.posts.bulkAdd([
    { id: 'w1', platform: 'threads', accountId: 'at', text: 'Winner one tentang nota hilang', mediaIds: [], status: 'published', fingerprint: 'w1', source: 'autopilot', attempts: 1, createdAt: 0, updatedAt: 0, publishedAt: old, engagement: 30 },
    { id: 'w2', platform: 'threads', accountId: 'at', text: 'Winner two tentang setrika', mediaIds: [], status: 'published', fingerprint: 'w2', source: 'autopilot', attempts: 1, createdAt: 0, updatedAt: 0, publishedAt: old, engagement: 20 },
  ]);
  const ok = 'Kelola laundry lebih rapi dengan CuciQu Pro, supaya semua pesanan tercatat dan kamu tidak perlu repot cari nota lagi.';
  const r = router([variation(ok)]);
  await runSlot(slot('threads'), slot().runAt, ctx(r));
  await runSlot({ ...slot('facebook'), id: 'q2' }, slot().runAt + 30 * MIN, ctx(r));
  const prompts = (r.generate.mock.calls as unknown[][]).map((c) => (c[0] as { messages: { content: string }[] }).messages[1].content);
  expect(prompts.filter((p) => /Winner one/.test(p))).toHaveLength(2);
  expect(prompts.some((p) => /Winner two/.test(p))).toBe(false);
});

describe('missed autopilot slots are carried over (best practice: max 2 per platform per day, max 3 days old)', () => {
  const base = Date.parse('2026-11-10T02:00:00Z'); // 09:00 WIB, day 10
  const run = (now: number, ran: string[]) =>
    processDue(now, {
      publishers: {} as never,
      notify: () => undefined,
      loadMedia: async () => [],
      runSlot: async (item) => {
        ran.push(item.id);
        await db.queue.delete(item.id);
      },
    });
  beforeEach(async () => {
    await updateSettings({ autopilot: { enabled: true, windowStart: '09:00', windowEnd: '19:00', platforms: { threads: true, facebook: false, fbgroup: false } } });
  });

  test('Chrome closed all of day 10 → on day 11 the latest runs now, others move to catch-up places', async () => {
    await db.queue.bulkAdd([0, 1, 2, 3].map((i) => ({ id: `s${i}`, kind: 'slot' as const, platform: 'threads' as const, slotKey: `2026-11-10#${i}`, contentType: 'tips', runAt: base + i * 120 * MIN })));
    const day11 = Date.parse('2026-11-11T01:00:00Z'); // 08:00 WIB, before the window
    const ran: string[] = [];
    await run(day11, ran);
    expect(ran).toEqual([]); // >2 h late: nothing posted blindly, everything carried over
    const q = (await db.queue.toArray()).sort((a, b) => a.runAt - b.runAt);
    expect(q).toHaveLength(4);
    expect(q.map((x) => x.slotKey)).toEqual(['2026-11-11#c0', '2026-11-11#c1', '2026-11-12#c0', '2026-11-12#c1']);
    expect(q.every((x) => x.missedAt && x.missedAt < day11)).toBe(true);
    // catch-up places are at 1/3 and 2/3 of the window + 20 min
    expect(new Date(q[0].runAt).toISOString()).toBe('2026-11-11T05:40:00.000Z'); // 12:40 WIB
    expect(new Date(q[1].runAt).toISOString()).toBe('2026-11-11T09:00:00.000Z'); // 16:00 WIB
  });

  test('a missed slot older than 3 days is dropped; autopilot off → dropped', async () => {
    await db.queue.add({ id: 'old', kind: 'slot', platform: 'threads', slotKey: '2026-11-06#0', contentType: 'tips', runAt: base - 4 * 24 * 60 * MIN });
    await run(base, []);
    expect(await db.queue.count()).toBe(0);
    await updateSettings({ autopilot: { enabled: false } });
    await db.queue.add({ id: 'x', kind: 'slot', platform: 'threads', slotKey: '2026-11-09#0', contentType: 'tips', runAt: base - 24 * 60 * MIN });
    await run(base, []);
    expect(await db.queue.count()).toBe(0);
  });

  test('inside the window today, a carried slot runs soon when today’s places already passed', async () => {
    await db.queue.add({ id: 's', kind: 'slot', platform: 'threads', slotKey: '2026-11-09#0', contentType: 'tips', runAt: base - 24 * 60 * MIN });
    const now = Date.parse('2026-11-10T10:30:00Z'); // 17:30 WIB (both places 12:40/16:00 passed)
    await run(now, []);
    const q = (await db.queue.toArray())[0];
    expect(q.slotKey).toBe('2026-11-10#c0');
    expect(q.runAt).toBe(now + 15 * MIN);
  });
});
