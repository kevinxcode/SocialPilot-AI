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
  expect(await new RpaPublisher('threads', f.d, 0).publish(post, [], { dryRun: true })).toEqual({ status: 'dry-run' });
  expect(f.closed()).toBe(0);
});

test('Threads publish opens the official compose intent URL after preflight', async () => {
  const f = fakeDriver({ preflight: [{ ok: true }], publish: [{ status: 'clicked' }], findExisting: [{ found: true }] });
  await new RpaPublisher('threads', f.d, 0).publish(post, [], {});
  const urls = (f.d.open as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  expect(urls[1]).toBe('https://www.threads.com/intent/post');
});
