import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { InstagramPage, countHashtags } from '@/pages/Instagram';
import { validateAccount } from '@/pages/SocialAccounts';
import { db, resetDb, seedIfEmpty } from '@/services/storage/db';
import { validatePost } from '@/services/content/validate';

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

const show = () =>
  render(
    <ToastProvider>
      <InstagramPage />
    </ToastProvider>,
  );

test('account URL: only an instagram.com profile is accepted', () => {
  expect(validateAccount('instagram', 'https://www.instagram.com/cuciqu.pro/', '')).toBeNull();
  expect(validateAccount('instagram', 'https://www.instagram.com/p/ABC/', '')).toMatch(/profile URL/);
  expect(validateAccount('instagram', 'https://www.threads.com/@cuciqu.pro', '')).toMatch(/instagram\.com/);
});

test('caption rules: 2200 characters and max 30 hashtags', async () => {
  await seedIfEmpty();
  const brand = (await db.brands.toCollection().first())!.id;
  expect(countHashtags('a #satu #dua #tiga_3')).toBe(3);
  const tooMany = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
  expect((await validatePost(tooMany, 'instagram', brand)).errors.join()).toMatch(/at most 30 hashtags/);
  expect((await validatePost('x'.repeat(2201), 'instagram', brand)).errors.join()).toMatch(/Instagram limit is 2200/);
});

test('page: account card, composer and the Instagram-only post list; scheduling needs an image', async () => {
  await db.posts.add({ id: 'fb', platform: 'facebook', accountId: 'a', text: 'post facebook', mediaIds: [], status: 'scheduled', scheduledAt: Date.now() + 1e6, fingerprint: 'fb', source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0 });
  await db.posts.add({ id: 'ig', platform: 'instagram', accountId: 'a', text: 'post instagram', mediaIds: ['m'], status: 'scheduled', scheduledAt: Date.now() + 1e6, fingerprint: 'ig', source: 'manual', attempts: 0, createdAt: 0, updatedAt: 0 });
  show();
  expect(await screen.findByText('Instagram account')).toBeTruthy();
  expect(await screen.findByText('post instagram')).toBeTruthy();
  expect(screen.queryByText('post facebook')).toBeNull();
  expect(screen.queryByLabelText('Platform filter')).toBeNull();
  fireEvent.change(screen.getByLabelText('Instagram caption'), { target: { value: 'Halo laundry #cuciqu' } });
  fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));
  await waitFor(() => expect(screen.getAllByText(/brand first|need an image/i).length).toBeGreaterThan(0));
  expect(await db.posts.where('platform').equals('instagram').count()).toBe(1); // nothing new was created
});

test('preview: caption cut after ~125 characters with "more", hashtags kept, links removed like when posting', async () => {
  const { InstagramPreview, joinCaption } = await import('@/pages/Instagram');
  const long = `${'Laundry rapi tanpa ribet setiap hari bersama kami. '.repeat(4)}Kunjungi https://cuciqu.id`;
  render(<InstagramPreview handle="cuciqu.app" caption={joinCaption(long, ['#laundry'])} />);
  const box = screen.getByLabelText('Instagram preview');
  expect(box.textContent).toContain('cuciqu.app');
  expect(box.textContent).toContain('more');
  expect(box.textContent).not.toContain('#laundry'); // cut off in the feed view
  fireEvent.click(screen.getByText('more'));
  expect(box.textContent).toContain('#laundry');
  expect(box.textContent).not.toContain('https://');
});

test('image picker with max 1: another image REPLACES the choice; clicking it again removes it; Clear empties it', async () => {
  const { MediaPicker } = await import('@/pages/PostActions');
  for (const id of ['a', 'b']) await db.media.add({ id, name: `${id}.png`, type: 'image/png', size: 1, tags: [], usedCount: 0, createdAt: id === 'a' ? 1 : 2, thumb: 'data:image/png;base64,AA' });
  const onChange = vi.fn();
  const { rerender } = render(<MediaPicker value={['a']} onChange={onChange} max={1} />);
  fireEvent.click(screen.getByRole('button', { name: /media/i }));
  const tiles = await screen.findAllByRole('button', { pressed: false });
  fireEvent.click(tiles[0]); // b (newest first)
  expect(onChange).toHaveBeenLastCalledWith(['b']);
  fireEvent.click(screen.getByRole('button', { pressed: true })); // a, already selected
  expect(onChange).toHaveBeenLastCalledWith([]);
  fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  rerender(<MediaPicker value={[]} onChange={onChange} max={1} />);
  expect(screen.queryByRole('button', { name: /clear selection/i })).toBeNull();
});

test('"Publish now" asks first, then starts publishing through the background worker', async () => {
  const messages = await import('@/background/messages');
  const send = vi.spyOn(messages, 'sendToSw').mockResolvedValue({ ok: true, message: 'started' } as never);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await seedIfEmpty();
  await db.media.add({ id: 'img', name: 'a.png', type: 'image/png', size: 1, blob: new Blob(['x'], { type: 'image/png' }), tags: [], usedCount: 0, createdAt: 1, thumb: 'data:image/png;base64,AA' });
  show();
  fireEvent.click((await screen.findAllByRole('button', { name: /^media$/i }))[0]); // the composer's (the dry-run card has one too)
  fireEvent.click((await screen.findAllByRole('button', { pressed: false }))[0]);
  fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
  fireEvent.change(screen.getByLabelText('Instagram caption'), { target: { value: 'Laundry rapi tanpa ribet bersama CuciQu setiap hari #laundry' } });
  fireEvent.click(screen.getByRole('button', { name: /publish now/i }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'publishNow', postId: expect.any(String) }));
  expect(window.confirm).toHaveBeenCalled();
});
