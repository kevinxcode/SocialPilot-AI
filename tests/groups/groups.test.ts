import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPreflight, runPublish } from '@/services/publishing/rpa/engine';
import { FBGROUP } from '@/services/publishing/rpa/selectors/fbgroup';
import { RpaPublisher, type Driver } from '@/services/publishing/rpa/RpaPublisher';
import { schedulePost, processDue, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { createDraft } from '@/services/publishing/posts';
import { planDay } from '@/services/autopilot/planner';
import { runSlot } from '@/services/autopilot/runner';
import { db, resetDb, CUCIQU_SEED } from '@/services/storage/db';
import { getSettings, updateSettings } from '@/services/storage/settings';
import type { Post } from '@/types/models';
import type { PublishResult } from '@/services/publishing/Publisher';
import type { Publisher } from '@/services/publishing/Publisher';

const fx = (p: string) => readFileSync(join(__dirname, '../fixtures', p), 'utf8');
const FAST = { timeoutMs: 400, pollMs: 10, delay: false };
const MIN = 60_000;
const T0 = Date.parse('2026-11-10T03:00:00Z');

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  document.body.innerHTML = '';
});

describe('engine — Facebook Group', () => {
  test('preflight fails when not a member (Join group)', async () => {
    document.body.innerHTML = fx('fbgroup/not-member.html');
    const r = await runPreflight(FBGROUP, { profileUrl: 'https://www.facebook.com/groups/laundry' }, FAST);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a member/i);
  });

  test('preflight passes when the group composer is available', async () => {
    document.body.innerHTML = fx('fbgroup/member.html');
    expect(await runPreflight(FBGROUP, { profileUrl: 'https://www.facebook.com/groups/laundry' }, FAST)).toEqual({ ok: true });
  });

  test('post that goes to admin approval is reported as pending', async () => {
    document.body.innerHTML = fx('fbgroup/member.html');
    const handler = (e: Event) => {
      const el = (e.target as HTMLElement).closest('[role="button"]');
      if (!el) return;
      const t = (el.textContent ?? '').trim();
      if (/^Write something/.test(t) && !document.querySelector('[role=dialog]')) {
        document.body.insertAdjacentHTML('beforeend', fx('facebook/composer.html').replace('AUTHOR', 'Budi'));
      } else if (el.getAttribute('aria-label') === 'Post') {
        document.querySelector('[role=dialog]')?.remove();
        document.body.insertAdjacentHTML('beforeend', '<div role="alert">Your post is pending approval by an admin.</div>');
      }
    };
    document.addEventListener('click', handler, { capture: true });
    const r = await runPublish(FBGROUP, { text: 'Tips laundry', files: [], dryRun: false }, FAST);
    document.removeEventListener('click', handler, { capture: true });
    expect(r).toEqual({ status: 'clicked', pending: true });
  });
});

function fakeDriver(responses: Record<string, unknown[]>) {
  const opened: string[] = [];
  const d: Driver = {
    open: vi.fn(async (url: string) => {
      opened.push(url);
      return 1;
    }),
    send: vi.fn(async (_t: number, msg: unknown) => {
      const q = responses[(msg as { cmd: string }).cmd];
      return (q.length > 1 ? q.shift() : q[0]) as never;
    }),
    close: vi.fn(async () => undefined),
  };
  return { d, opened };
}

const gpost = (p: Partial<Post> = {}): Post => ({
  id: 'g1', platform: 'fbgroup', accountId: '', groupId: 'grp1', text: 'Tips memisahkan cucian', mediaIds: [], status: 'processing',
  fingerprint: 'tips memisahkan cucian', source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0, ...p,
});

describe('publisher — Facebook Group', () => {
  beforeEach(async () => {
    await db.groups.add({ id: 'grp1', name: 'Pengusaha Laundry', url: 'https://www.facebook.com/groups/laundry', rules: '', enabled: true });
  });

  test('opens the post’s group URL', async () => {
    const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], findExisting: [{ found: true, url: 'https://www.facebook.com/groups/laundry/posts/1' }] });
    const r = await new RpaPublisher('fbgroup', f.d, 0).publish(gpost(), [], {});
    expect(r).toEqual({ status: 'published', url: 'https://www.facebook.com/groups/laundry/posts/1' });
    expect(f.opened[0]).toBe('https://www.facebook.com/groups/laundry');
  });

  test('pending admin approval → published with a note, no feed confirmation needed', async () => {
    const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked', pending: true }], findExisting: [{ found: false }] });
    const r = await new RpaPublisher('fbgroup', f.d, 0).publish(gpost(), [], {});
    expect(r).toEqual({ status: 'published', note: 'Pending admin approval in the group' });
  });

  test('missing or disabled group → failed, nothing opened', async () => {
    await db.groups.update('grp1', { enabled: false });
    const f = fakeDriver({});
    const r = await new RpaPublisher('fbgroup', f.d, 0).publish(gpost(), [], {});
    expect(r.status).toBe('failed');
    expect(f.opened).toEqual([]);
  });
});

describe('queue — group pacing', () => {
  const pub = (): Publisher & { calls: number } => {
    const p = {
      platform: 'fbgroup' as const,
      calls: 0,
      preflight: async () => ({ ok: true }),
      publish: async (): Promise<PublishResult> => {
        p.calls++;
        return { status: 'published' };
      },
      findExisting: async () => ({ found: false }),
    };
    return p;
  };
  const deps = (p: Publisher): QueueDeps => ({ publishers: { threads: p, facebook: p, fbgroup: p }, notify: () => undefined, loadMedia: async () => [] });
  const add = (id: string, x: Partial<Post>) =>
    db.posts.put({ ...gpost({ id, fingerprint: id, status: 'draft' }), ...x });

  test('posts to different groups are spaced by groupGapMinutes (30), not the 60-min platform gap', async () => {
    await add('old', { groupId: 'other', status: 'published', publishedAt: T0 - 35 * MIN });
    await add('p1', { groupId: 'grp1' });
    await schedulePost('p1', new Date(T0));
    const p = pub();
    await processDue(T0, deps(p));
    expect(p.calls).toBe(1);
  });

  test('at most one post per group per 24 h', async () => {
    await add('old', { groupId: 'grp1', status: 'published', publishedAt: T0 - 5 * 60 * MIN });
    await add('p1', { groupId: 'grp1' });
    await schedulePost('p1', new Date(T0));
    const p = pub();
    await processDue(T0, deps(p));
    expect(p.calls).toBe(0);
    expect((await db.queue.toArray())[0].runAt).toBe(T0 - 5 * 60 * MIN + 24 * 60 * MIN);
  });
});

describe('auto-pick picture', () => {
  beforeEach(async () => {
    await db.media.bulkAdd([
      { id: 'img1', name: 'promo.png', type: 'image/png', size: 1, blob: new Blob(['a']), tags: ['promo'], usedCount: 0, createdAt: 1 },
      { id: 'img2', name: 'tips-laundry.png', type: 'image/png', size: 1, blob: new Blob(['b']), tags: ['tips', 'laundry'], usedCount: 0, createdAt: 2 },
    ]);
  });

  test('a post without media gets an unused image matching its content type', async () => {
    const p = await createDraft({ platform: 'threads', text: 'x', contentType: 'tips' });
    expect(p.mediaIds).toEqual(['img2']);
  });

  test('explicit media is kept; autoPickMedia=false leaves it empty', async () => {
    expect((await createDraft({ platform: 'threads', text: 'x', mediaIds: ['img1'] })).mediaIds).toEqual(['img1']);
    await updateSettings({ autoPickMedia: false });
    expect((await createDraft({ platform: 'threads', text: 'x', contentType: 'tips' })).mediaIds).toEqual([]);
  });

  test('empty library → text-only post', async () => {
    await db.media.clear();
    expect((await createDraft({ platform: 'threads', text: 'x' })).mediaIds).toEqual([]);
  });
});

describe('autopilot — groups', () => {
  test('one group slot per day, 60 min after the first Threads slot', async () => {
    await updateSettings({ autopilot: { enabled: true, postsPerDay: 2, platforms: { threads: true, facebook: true, fbgroup: true } } });
    const slots = planDay('2026-11-10', await getSettings()).filter((s) => s.platform === 'fbgroup');
    expect(slots).toHaveLength(1);
    expect(new Date(slots[0].runAt).toISOString()).toBe('2026-11-10T05:30:00.000Z');
  });

  test('runner picks the enabled group posted to least recently and writes with its rules', async () => {
    await db.brands.add({ ...CUCIQU_SEED, id: 'b1', createdAt: 0, updatedAt: 0 });
    await updateSettings({ autopilot: { enabled: true, platforms: { threads: true, facebook: true, fbgroup: true } } });
    await db.groups.bulkAdd([
      { id: 'a', name: 'A', url: 'https://www.facebook.com/groups/a', rules: 'Dilarang link', enabled: true },
      { id: 'b', name: 'B', url: 'https://www.facebook.com/groups/b', rules: 'Tanpa promosi', enabled: true },
    ]);
    await db.posts.put(gpost({ id: 'prev', groupId: 'a', status: 'published', publishedAt: Date.now() - 60 * MIN }));
    const item = { id: 's', kind: 'slot' as const, platform: 'fbgroup' as const, slotKey: 'd#0', contentType: 'tips', runAt: Date.now() };
    await db.queue.add(item);
    const router = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({ variations: [{ caption: 'Tips: pisahkan cucian per pelanggan dengan label.' }] }),
        providerId: 'ollama' as const,
        modelId: 'm',
      })),
    };
    await runSlot(item, Date.now(), { notify: () => undefined, router });
    const created = (await db.posts.toArray()).find((p) => p.id !== 'prev')!;
    expect(created).toMatchObject({ platform: 'fbgroup', groupId: 'b', source: 'autopilot' });
    const prompt = ((router.generate.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] }).messages[1].content;
    expect(prompt).toMatch(/Tanpa promosi/);
  });
});

test('collectGroups reads joined groups and skips nav links', async () => {
  const { collectGroups } = await import('@/services/publishing/rpa/engine');
  document.body.innerHTML = `
    <a href="/groups/feed/">Feed</a><a href="/groups/discover/">Discover</a>
    <a href="https://www.facebook.com/groups/pengusahalaundry/"><img/></a>
    <a href="https://www.facebook.com/groups/pengusahalaundry/">Pengusaha Laundry Indonesia</a>
    <a href="/groups/123456/">Lihat grup</a><a href="/groups/123456/">UMKM Kaltim</a>
    <a href="/groups/123456/posts/9/">a post</a>`;
  expect(collectGroups()).toEqual([
    { name: 'Pengusaha Laundry Indonesia', url: 'https://www.facebook.com/groups/pengusahalaundry' },
    { name: 'UMKM Kaltim', url: 'https://www.facebook.com/groups/123456' },
  ]);
});
