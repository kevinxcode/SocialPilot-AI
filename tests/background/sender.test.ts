import { isTrustedSender } from '@/background/sender';

const ID = 'extid';
const BASE = 'chrome-extension://extid/';

test('[review#1] dashboard opened in a tab is trusted', () => {
  expect(isTrustedSender({ id: ID, url: `${BASE}src/dashboard/index.html#/studio`, tab: { id: 5 } as chrome.tabs.Tab }, ID, BASE)).toBe(true);
});
test('popup (no tab) is trusted', () => {
  expect(isTrustedSender({ id: ID, url: `${BASE}src/popup/index.html` }, ID, BASE)).toBe(true);
});
test('content script on facebook.com is not trusted', () => {
  expect(isTrustedSender({ id: ID, url: 'https://www.facebook.com/x', tab: { id: 9 } as chrome.tabs.Tab }, ID, BASE)).toBe(false);
});
test('other extension is not trusted', () => {
  expect(isTrustedSender({ id: 'other', url: 'chrome-extension://other/x' }, ID, BASE)).toBe(false);
});
