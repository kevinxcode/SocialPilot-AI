// @vitest-environment jsdom
import { autoReorder, processDue, schedulePost, type QueueDeps } from '@/services/publishing/PublishingQueue';
import { planDay } from '@/services/autopilot/planner';
import { automaticComments } from '@/services/autopilot/comments';
import { addCommentIdeas, commentIdeas } from '@/services/autopilot/commentIdeas';
import { forgetDriveSync, syncDriveLink } from '@/services/media/driveSync';
import { DEFAULT_SETTINGS, updateSettings } from '@/services/storage/settings';
import { db, resetDb, seedIfEmpty } from '@/services/storage/db';
import type { RouterLike } from '@/services/content/generate';
import type { Post } from '@/types/models';

const T = Date.parse('2026-11-09T05:00:00Z');
const SCAN = 31 * 60_000;
const post = (p: Partial<Post> = {}): Post => ({ id: 'p', platform: 'threads', accountId: 'a', text: 'teks', mediaIds: [], status: 'draft', fingerprint: 'teks', source: 'autopilot', attempts: 0, createdAt: 0, updatedAt: 0, ...p });
const threadsOnly = { threads: true, facebook: false, fbgroup: false, instagram: false };
const notRelevant: RouterLike = { generate: async () => ({ text: JSON.stringify({ relevant: false, confidence: 0.1, comment: '' }), providerId: 'ollama', modelId: 't', latencyMs: 1 }) };
const found = async () => [{ query: 'q', posts: [{ text: 'Tanya laundry', url: 'https://www.threads.com/@o/post/abc', engagement: 1 }] }];

function publisher() {
  const publish = vi.fn(async () => ({ status: 'published' as const }));
  const pub = { platform: 'threads' as const, preflight: async () => ({ ok: true }), publish, findExisting: async () => ({ found: false }) };
  const deps: QueueDeps = { publishers: { threads: pub, facebook: pub, fbgroup: pub, instagram: pub }, notify: () => undefined, loadMedia: async () => [] };
  return { publish, deps };
}

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  await seedIfEmpty();
});
afterEach(() => vi.restoreAllMocks());

test('group posts per day do not depend on posts per day', () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.autopilot = { ...s.autopilot, enabled: true, paused: false, postsPerDay: 2, groupPostsPerDay: 5, windowStart: '09:00', windowEnd: '19:00', platforms: { ...threadsOnly, fbgroup: true } };
  const slots = planDay('2026-11-10', s).filter((q) => q.platform === 'fbgroup');
  expect(slots).toHaveLength(5);
  expect(new Set(slots.map((q) => q.slotKey)).size).toBe(5);
  expect(new Set(slots.map((q) => q.runAt)).size).toBe(5);
  const end = Date.parse('2026-11-10T12:00:00Z');
  expect(slots.every((q) => q.runAt <= end)).toBe(true);
});

describe('comment ideas', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({ settings: { ...structuredClone(DEFAULT_SETTINGS), autopilot: { ...structuredClone(DEFAULT_SETTINGS.autopilot), enabled: true } } });
    await db.accounts.add({ id: 'a', platform: 'threads', name: 'me', profileUrl: 'https://www.threads.com/@me' });
    await addCommentIdeas([{ id: 'i', title: 'Catatan laundry', body: '' }]);
    vi.spyOn(Date, 'now').mockReturnValue(T);
  });

  test('a failed or empty search never uses up an idea', async () => {
    for (let i = 0; i < 2; i++) await automaticComments(T + i * SCAN, { router: notRelevant, scrape: async () => { throw new Error('logged out'); } }).catch(() => undefined);
    for (let i = 2; i < 5; i++) await automaticComments(T + i * SCAN, { router: notRelevant, scrape: async () => [{ query: 'q', posts: [] }] });
    expect(await commentIdeas()).toHaveLength(1);
    expect((await commentIdeas())[0].searches ?? 0).toBe(0);
  });

  test('an AI failure never uses up an idea', async () => {
    const down: RouterLike = { generate: async () => { throw new Error('AI down'); } };
    for (let i = 0; i < 4; i++) await automaticComments(T + i * SCAN, { router: down, scrape: found }).catch(() => undefined);
    expect(await commentIdeas()).toHaveLength(1);
  });

  test('an idea is dropped after 3 searches that read posts but found none relevant', async () => {
    for (let i = 0; i < 3; i++) await automaticComments(T + i * SCAN, { router: notRelevant, scrape: found });
    expect(await commentIdeas()).toHaveLength(0);
  });
});

test('replies on our own posts follow their own switch, not Automatic comments', async () => {
  await updateSettings({ comments: { enabled: false }, autopilot: { enabled: true, platforms: threadsOnly } });
  await db.posts.put(post({ replyTo: 'https://www.threads.com/@x/post/a', replyTargetText: 'x', replyKind: 'own' }));
  await schedulePost('p', new Date(T));
  const own = publisher();
  await processDue(T + 1000, own.deps);
  expect(own.publish).toHaveBeenCalledTimes(1);
  await db.posts.put(post({ id: 'c', text: 'komentar', fingerprint: 'komentar', replyTo: 'https://www.threads.com/@x/post/b', replyTargetText: 'x' }));
  await schedulePost('c', new Date(T + 11 * 60_000));
  const outreach = publisher();
  await processDue(T + 12 * 60_000, outreach.deps);
  expect(outreach.publish).not.toHaveBeenCalled();
});

test('an autopilot post on hold keeps its time; a manual post is still spread', async () => {
  await updateSettings({ autopilot: { enabled: false } });
  await db.posts.put(post());
  await schedulePost('p', new Date(T));
  expect(await autoReorder(T + 60_000)).toBe(0);
  expect((await db.posts.get('p'))?.scheduledAt).toBe(T);
  await db.posts.put(post({ id: 'm', source: 'manual', text: 'manual', fingerprint: 'manual' }));
  await schedulePost('m', new Date(T));
  expect(await autoReorder(T + 60_000)).toBe(1);
});

describe('Google Drive', () => {
  const html = '<title>F</title><div class="flip-entry" id="entry-f1"><a href="https://drive.google.com/file/d/f1/view"><div class="flip-entry-title">a.png</div></a></div>';
  const folder = (async (u: string) => (u.includes('embedded') ? new Response(html, { headers: { 'content-type': 'text/html' } }) : new Response('x', { headers: { 'content-type': 'image/png' } }))) as unknown as typeof fetch;

  test('after clearing the library, a sync brings the files back', async () => {
    await syncDriveLink('https://drive.google.com/drive/folders/r', { fetch: folder });
    await db.media.clear();
    await forgetDriveSync();
    expect((await syncDriveLink('https://drive.google.com/drive/folders/r', { fetch: folder })).added).toBe(1);
  });

  test('a single-file link keeps its real name and type', async () => {
    const f = (async () => new Response('v', { headers: { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="old.bin"; filename*=UTF-8''promo%20satu.mp4` } })) as unknown as typeof fetch;
    await syncDriveLink('https://drive.google.com/file/d/video1/view', { fetch: f });
    expect((await db.media.toArray())[0]).toMatchObject({ name: 'promo satu.mp4', type: 'video/mp4' });
  });

  test('a single-file link without a name uses the type Drive reports', async () => {
    const f = (async () => new Response('i', { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    await syncDriveLink('https://drive.google.com/file/d/img1/view', { fetch: f });
    expect((await db.media.toArray())[0]).toMatchObject({ name: 'drive-img1.png', type: 'image/png' });
  });

  test('a single-file link that is not media is refused', async () => {
    const f = (async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="doc.pdf"' } })) as unknown as typeof fetch;
    const r = await syncDriveLink('https://drive.google.com/file/d/doc1/view', { fetch: f });
    expect(r.added).toBe(0);
    expect(r.failed[0]).toMatch(/not an image or video/);
  });
});
