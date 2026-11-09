import { validateAccount } from '@/pages/SocialAccounts';

test('Threads profile URL validation', () => {
  expect(validateAccount('threads', 'https://www.threads.com/@cuciqu.pro', '')).toBeNull();
  expect(validateAccount('threads', 'https://www.threads.net/@cuciqu.pro/', '')).toBeNull();
  expect(validateAccount('threads', 'https://www.threads.com/', '')).toMatch(/profile URL/);
  expect(validateAccount('threads', 'threads.com/@x', '')).toMatch(/https/);
});

test('Facebook Page URL requires page path and name', () => {
  expect(validateAccount('facebook', 'https://www.facebook.com/cuciqupro', 'CuciQu Pro')).toBeNull();
  expect(validateAccount('facebook', 'https://www.facebook.com/', 'CuciQu Pro')).toMatch(/Page URL/);
  expect(validateAccount('facebook', 'https://www.facebook.com/cuciqupro', ' ')).toMatch(/Page name/);
  expect(validateAccount('facebook', 'https://evil.example/cuciqupro', 'X')).toMatch(/facebook\.com/);
});
