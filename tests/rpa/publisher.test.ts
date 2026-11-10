import { RpaPublisher, type Driver } from '@/services/publishing/rpa/RpaPublisher';
import { db, resetDb } from '@/services/storage/db';
import type { Post } from '@/types/models';

const post: Post = {
  id: 'p', platform: 'threads', accountId: 'a', text: 'Halo 🧺', mediaIds: [], status: 'processing', fingerprint: 'halo',
  source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0,
};

function fakeDriver(responses: Record<string, unknown[]>) {
  const sent: string[] = [];
  let closed = 0;
  const d: Driver = {
    open: vi.fn(async () => 1),
    send: vi.fn(async (_t: number, msg: unknown) => {
      const cmd = (msg as { cmd: string }).cmd;
      sent.push(cmd);
      const q = responses[cmd];
      const r = q.length > 1 ? q.shift() : q[0];
      if (r instanceof Error) throw r;
      return r as never;
    }),
    close: vi.fn(async () => {
      closed++;
    }),
  };
  return { d, sent, closed: () => closed };
}

beforeEach(async () => {
  await resetDb();
  await db.accounts.add({ id: 'a', platform: 'threads', name: 'cuciqu.pro', profileUrl: 'https://www.threads.com/@cuciqu.pro' });
});

test('preflight failure → failed, publish command never sent', async () => {
  const f = fakeDriver({ preflight: [{ ok: false, reason: 'Not logged in' }] });
  const r = await new RpaPublisher('threads', f.d, 0).publish(post, [], {});
  expect(r).toEqual({ status: 'failed', reason: 'Not logged in' });
  expect(f.sent).toEqual(['preflight']);
});

test('clicked and found on feed → published with url', async () => {
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], findExisting: [{ found: true, url: 'https://www.threads.com/@x/post/1' }] });
  const r = await new RpaPublisher('threads', f.d, 0).publish(post, [new Blob(['x'], { type: 'image/png' })], {});
  expect(r).toEqual({ status: 'published', url: 'https://www.threads.com/@x/post/1' });
  expect(f.sent).toEqual(['preflight', 'publish', 'findExisting']);
  expect(f.closed()).toBe(1);
});

test('clicked but not visible on feed → unknown (never claimed published)', async () => {
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], findExisting: [{ found: false }] });
  const r = await new RpaPublisher('threads', f.d, 0).publish(post, [], {});
  expect(r.status).toBe('unknown');
});

test('error before the publish command → failed; error after → unknown', async () => {
  const before = fakeDriver({ preflight: [new Error('Page load timed out')] });
  expect((await new RpaPublisher('threads', before.d, 0).publish(post, [], {})).status).toBe('failed');
  const after = fakeDriver({ preflight: [{ ok: true }], publish: [new Error('Automation step timed out')] });
  expect((await new RpaPublisher('threads', after.d, 0).publish(post, [], {})).status).toBe('unknown');
});

test('missing account → failed', async () => {
  await db.accounts.clear();
  const f = fakeDriver({});
  const r = await new RpaPublisher('threads', f.d, 0).publish(post, [], {});
  expect(r).toMatchObject({ status: 'failed' });
});

test('dry run leaves the window open', async () => {
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'dry-run' }] });
  expect(await new RpaPublisher('threads', f.d, 0).publish(post, [], { dryRun: true })).toMatchObject({ status: 'dry-run' });
  expect(f.closed()).toBe(0);
});

test('Threads publish opens the official compose intent URL after preflight', async () => {
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], findExisting: [{ found: true }] });
  await new RpaPublisher('threads', f.d, 0).publish(post, [], {});
  const urls = (f.d.open as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  expect(urls[1]).toBe('https://www.threads.com/intent/post');
});

test('Threads replies open the parent post and verify the reply instead of creating a root post', async () => {
  const target = 'https://www.threads.com/@owner/post/abc';
  const f = fakeDriver({ preflight: [{ ok: true }], reply: [{ status: 'clicked' }], findReply: [{ found: true, url: 'https://www.threads.com/@cuciqu.pro/post/reply' }] });
  const r = await new RpaPublisher('threads', f.d, 0).publish({ ...post, replyTo: target, replyTargetText: 'Original question' }, [], {});
  expect(r.status).toBe('published');
  expect(f.sent).toEqual(['preflight', 'reply', 'findReply']);
  expect(f.d.open).toHaveBeenNthCalledWith(2, target, { focus: true });
});

describe('Instagram', () => {
  const igPost: Post = { ...post, platform: 'instagram', text: 'Laundry rapi bersama CuciQu Pro https://cuciqu.id', fingerprint: 'laundry rapi bersama cuciqu pro' };
  const img = new Blob(['x'], { type: 'image/png' });
  beforeEach(async () => {
    await db.accounts.add({ id: 'ig', platform: 'instagram', name: 'cuciqu.pro', profileUrl: 'https://www.instagram.com/cuciqu.pro/' });
  });

  test('no image → failed before anything is opened', async () => {
    const f = fakeDriver({});
    expect(await new RpaPublisher('instagram', f.d, 0).publish(igPost, [], {})).toMatchObject({ status: 'failed', reason: expect.stringMatching(/image or video/) });
    expect(f.d.open).not.toHaveBeenCalled();
  });

  test('shared → confirmed by opening the newest posts and reading their caption; links are removed from the caption', async () => {
    const f = fakeDriver({
      preflight: [{ ok: true }],
      publish: [{ status: 'clicked' }],
      recentPosts: [{ urls: ['https://www.instagram.com/p/OLD/', 'https://www.instagram.com/p/NEW/'] }],
      findExisting: [{ found: false }, { found: true }],
    });
    const r = await new RpaPublisher('instagram', f.d, 0).publish(igPost, [img], {});
    expect(r).toEqual({ status: 'published', url: 'https://www.instagram.com/p/NEW/' });
    expect(f.sent).toEqual(['preflight', 'publish', 'recentPosts', 'findExisting', 'findExisting']);
    const findMsg = (f.d.send as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as { cmd: string }).cmd === 'findExisting')![1] as { since?: number };
    expect(findMsg.since).toBeGreaterThan(Date.now() - 60_000); // only posts newer than this run are accepted
    const publishMsg = (f.d.send as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as { cmd: string }).cmd === 'publish')![1] as { input: { text: string } };
    expect(publishMsg.input.text).not.toContain('https://');
  });

  test('shared but not found among the newest posts → unknown (checked again before any retry)', async () => {
    const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], recentPosts: [{ urls: ['https://www.instagram.com/p/OLD/'] }], findExisting: [{ found: false }] });
    expect((await new RpaPublisher('instagram', f.d, 0).publish(igPost, [img], {})).status).toBe('unknown');
  });

  test('findExisting (used by the "verifying" step) looks at the profile the same way', async () => {
    const f = fakeDriver({ recentPosts: [{ urls: ['https://www.instagram.com/p/NEW/'] }], findExisting: [{ found: true }] });
    expect(await new RpaPublisher('instagram', f.d, 0).findExisting(igPost)).toEqual({ found: true, url: 'https://www.instagram.com/p/NEW/' });
  });
});

describe('Facebook Group: "Your content" counts as success', () => {
  const gPost: Post = { ...post, platform: 'fbgroup', groupId: 'g1', fingerprint: 'laundry bekasi rapi' };
  beforeEach(async () => {
    await db.groups.add({ id: 'g1', name: 'Laundry Bekasi', url: 'https://www.facebook.com/groups/685112895274502', enabled: true } as never);
  });

  test('not in the feed, but under Pending → success (pending approval)', async () => {
    const f = fakeDriver({ findExisting: [{ found: false }, { found: true }] });
    expect(await new RpaPublisher('fbgroup', f.d, 0).findExisting(gPost)).toEqual({ found: true, pending: true });
    expect((f.d.open as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'https://www.facebook.com/groups/685112895274502',
      'https://www.facebook.com/groups/685112895274502/my_pending_content',
    ]);
  });

  test('not in the feed nor Pending, but under Published → success', async () => {
    const f = fakeDriver({ findExisting: [{ found: false }, { found: false }, { found: true, url: 'https://www.facebook.com/groups/685112895274502/posts/1' }] });
    expect(await new RpaPublisher('fbgroup', f.d, 0).findExisting(gPost)).toEqual({ found: true, url: 'https://www.facebook.com/groups/685112895274502/posts/1' });
    expect((f.d.open as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('https://www.facebook.com/groups/685112895274502/my_posted_content');
  });

  test('nowhere → not found', async () => {
    const f = fakeDriver({ findExisting: [{ found: false }] });
    expect(await new RpaPublisher('fbgroup', f.d, 0).findExisting(gPost)).toEqual({ found: false });
  });
});

test('Instagram: the caption proof is logged right after Share, even if the profile check is then interrupted', async () => {
  await db.accounts.add({ id: 'ig2', platform: 'instagram', name: 'cuciqu.app', profileUrl: 'https://www.instagram.com/cuciqu.app/' });
  const closed = Object.assign(new Error('Automation tab was closed'), { name: 'TabClosedError' });
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked', note: 'Caption: keys, counter 412/2,200' }], recentPosts: [closed] });
  const p: Post = { ...post, platform: 'instagram', accountId: 'ig2', fingerprint: 'laundry rapi bersama cuciqu pro' };
  expect((await new RpaPublisher('instagram', f.d, 0).publish(p, [new Blob(['x'], { type: 'image/png' })], {})).status).toBe('cancelled');
  const logs = await db.logs.toArray();
  expect(logs.some((l) => /shared — Caption: keys, counter 412\/2,200/.test(l.message))).toBe(true);
});
