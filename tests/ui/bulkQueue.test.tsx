import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { ScheduledPostsPage } from '@/pages/ScheduledPosts';
import { db, resetDb } from '@/services/storage/db';
import type { Post } from '@/types/models';

const post = (id: string, p: Partial<Post> = {}): Post => ({
  id, platform: 'threads', accountId: 'a', text: `teks ${id}`, mediaIds: [], status: 'scheduled', scheduledAt: Date.now() + 3600_000,
  fingerprint: id, source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0, ...p,
});

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
  await db.posts.bulkAdd([post('p1'), post('p2'), post('busy', { status: 'processing' })]);
  for (const id of ['p1', 'p2']) await db.queue.add({ id: `q${id}`, kind: 'post', platform: 'threads', postId: id, runAt: Date.now() + 3600_000 });
});

const show = () =>
  render(
    <ToastProvider>
      <ScheduledPostsPage />
    </ToastProvider>,
  );

test('select posts → Pause, then Resume; a post being published cannot be selected', async () => {
  show();
  const box = await screen.findByLabelText(/select post teks p1/i);
  expect((screen.getByLabelText(/select post teks busy/i) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(box);
  fireEvent.click(screen.getByLabelText(/select post teks p2/i));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /pause/i }));
  await waitFor(async () => expect((await db.posts.get('p1'))?.paused).toBe(true));
  expect((await db.posts.get('p2'))?.paused).toBe(true);
  fireEvent.click(await screen.findByLabelText('Select all'));
  fireEvent.click(screen.getByRole('button', { name: /resume/i }));
  await waitFor(async () => expect((await db.posts.get('p1'))?.paused).toBeUndefined());
});

test('select all → Cancel (after confirming) cancels them and removes them from the queue', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  show();
  fireEvent.click(await screen.findByLabelText('Select all'));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
  await waitFor(async () => expect((await db.posts.get('p1'))?.status).toBe('cancelled'));
  expect((await db.posts.get('p2'))?.status).toBe('cancelled');
  expect((await db.posts.get('busy'))?.status).toBe('processing');
  expect(await db.queue.count()).toBe(0);
});

test('status is never "scheduled" and "paused" at once; details say what happens next', async () => {
  const { postDetail } = await import('@/pages/PostEditor');
  const fmt = () => '10:40';
  await db.posts.update('p1', { paused: true, error: 'Waiting: min 10 min gap after the last Threads post' });
  await db.posts.update('p2', { error: 'Post button not found or disabled', nextRetryAt: 1 });
  show();
  await screen.findByText(/paused by you/i);
  const row1 = screen.getByLabelText(/select post teks p1/i).closest('tr')!;
  expect(row1.textContent).toContain('paused');
  expect(row1.textContent).not.toContain('scheduled');
  expect(row1.textContent).not.toContain('Waiting');
  expect(postDetail((await db.posts.get('p2'))!, fmt).text).toBe('Last attempt failed: Post button not found or disabled · next try 10:40');
  expect(postDetail({ ...(await db.posts.get('p2'))!, error: undefined, source: 'autopilot' }, fmt, true).text).toMatch(/autopilot is paused/i);
});

test('queue order: being published first, then scheduled (earliest first), paused at the bottom', async () => {
  const { queueRank } = await import('@/pages/ScheduledPosts');
  const sorted = [post('a', { paused: true, scheduledAt: 1 }), post('b', { scheduledAt: 3 }), post('c', { status: 'processing', scheduledAt: 9 }), post('d', { scheduledAt: 2 })]
    .sort((x, y) => queueRank(x) - queueRank(y) || (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0))
    .map((p) => p.id);
  expect(sorted).toEqual(['c', 'd', 'b', 'a']);
});

test('a "verifying" post can be selected and marked as published', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await db.posts.add(post('ver', { status: 'verifying', error: 'Instagram post not yet visible' }));
  await db.queue.add({ id: 'qver', kind: 'post', platform: 'threads', postId: 'ver', runAt: Date.now() });
  show();
  const box = (await screen.findByLabelText(/select post teks ver/i)) as HTMLInputElement;
  expect(box.disabled).toBe(false);
  fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: /mark as published/i }));
  await waitFor(async () => expect((await db.posts.get('ver'))?.status).toBe('published'));
});
