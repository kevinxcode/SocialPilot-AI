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
