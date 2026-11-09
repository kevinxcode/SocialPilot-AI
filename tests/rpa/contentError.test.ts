import { runPublish } from '@/services/publishing/rpa/engine';
import { THREADS } from '@/services/publishing/rpa/selectors/threads';
import * as dom from '@/services/publishing/rpa/dom';

test('[review#4] exception after Post was clicked → unknown, not failed', async () => {
  document.body.innerHTML = '<div role="button"><svg aria-label="Create"></svg></div>';
  document.addEventListener('click', () => {
    if (!document.querySelector('[role=dialog]')) document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div contenteditable="true" role="textbox"></div><div role="button">Post</div></div>');
  }, { capture: true, once: false });
  const orig = dom.waitFor;
  let calls = 0;
  const spy = vi.spyOn(dom, 'waitFor').mockImplementation(async (fn, ms, poll) => {
    calls++;
    if (calls === 5) throw new Error('detached'); // the wait after clicking Post
    return orig(fn, ms, poll);
  });
  const r = await runPublish(THREADS, { text: 'x', files: [], dryRun: false }, { timeoutMs: 300, pollMs: 10, delay: false });
  spy.mockRestore();
  expect(r.status).toBe('unknown');
});
