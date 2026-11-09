import { waitForContentScript } from '@/services/publishing/rpa/ready';

test('retries ping until the content script answers', async () => {
  let n = 0;
  const send = vi.fn(async () => {
    if (++n < 4) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true };
  });
  await waitForContentScript(send, 2000, 5);
  expect(send).toHaveBeenCalledTimes(4);
});

test('gives a clear error when the script never answers', async () => {
  const send = vi.fn(async () => {
    throw new Error('Receiving end does not exist.');
  });
  await expect(waitForContentScript(send, 50, 5)).rejects.toThrow(/automation script did not start/i);
});

test('retryTabEdit retries while the user drags a tab, rethrows other errors', async () => {
  const { retryTabEdit } = await import('@/services/publishing/rpa/tabDriver');
  let n = 0;
  await expect(retryTabEdit(async () => (++n < 3 ? Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).')) : 'ok'), 5, 1)).resolves.toBe('ok');
  expect(n).toBe(3);
  await expect(retryTabEdit(async () => Promise.reject(new Error('No tab with id')), 5, 1)).rejects.toThrow(/No tab/);
});
