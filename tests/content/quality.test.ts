import { qualityIssues } from '@/services/content/quality';
import { withUtm, appendLink } from '@/lib/utm';
import { matchEngagement, angleHints } from '@/services/analytics/engagement';
import type { Post } from '@/types/models';

const good = 'Pelanggan laundry sering komplain soal nota hilang? Coba catat semua order di satu aplikasi supaya tidak ada yang tercecer. Kamu biasanya pakai buku atau aplikasi?';

test('a normal Indonesian post passes', () => {
  expect(qualityIssues(good, 'id')).toEqual([]);
});

test('model artefacts are caught', () => {
  expect(qualityIssues(`<think>hmm</think> ${good}`, 'id').join()).toMatch(/reasoning/);
  expect(qualityIssues(`{"caption": "${good}"}`, 'id').join()).toMatch(/JSON/);
  expect(qualityIssues(`${good}\\nlagi`, 'id').join()).toMatch(/line break/);
  expect(qualityIssues('```\n' + good + '\n```', 'id').join()).toMatch(/code/);
  expect(qualityIssues(`Halo [Nama Pelanggan], ${good}`, 'id').join()).toMatch(/placeholder/);
});

test('too short and wrong language are caught', () => {
  expect(qualityIssues('Halo semua!', 'id').join()).toMatch(/short/);
  const en = 'Customers often complain about lost receipts. Try recording every order in one app so nothing gets lost. What do you use today?';
  expect(qualityIssues(en, 'id').join()).toMatch(/language/);
  expect(qualityIssues(en, 'en')).toEqual([]);
});

test('too many hashtags is caught', () => {
  expect(qualityIssues(`${good} ${Array.from({ length: 9 }, (_, i) => `#tag${i}`).join(' ')}`, 'id').join()).toMatch(/hashtag/);
});

test('UTM is added without breaking existing params', () => {
  expect(withUtm('https://cuciqu.com', 'threads')).toBe('https://cuciqu.com/?utm_source=threads&utm_medium=social&utm_campaign=autopilot');
  expect(withUtm('https://cuciqu.com/a?x=1&utm_source=old', 'threads')).toBe('https://cuciqu.com/a?x=1&utm_source=threads&utm_medium=social&utm_campaign=autopilot');
  expect(withUtm('not a url', 'threads')).toBeNull();
});

test('appendLink adds the link once and respects the limit', () => {
  const url = 'https://cuciqu.com/?utm_source=threads';
  expect(appendLink('Halo #laundry', url, 500)).toBe(`Halo #laundry\n\n${url}`);
  expect(appendLink(`Halo ${url}`, url, 500)).toBe(`Halo ${url}`);
  expect(appendLink('a'.repeat(480), url, 500)).toBe('a'.repeat(480));
});

const post = (id: string, text: string, extra: Partial<Post> = {}): Post => ({
  id, platform: 'threads', accountId: 'a', text, mediaIds: [], status: 'published', fingerprint: id, source: 'autopilot',
  attempts: 1, createdAt: 0, updatedAt: 0, publishedAt: 1, ...extra,
});

test('engagement is matched by url first, then by text start', () => {
  const posts = [post('1', 'Tips laundry hari ini: pisahkan baju putih', { url: 'https://www.threads.com/@x/post/AAA' }), post('2', 'Nota hilang bikin pusing pelanggan ya')];
  const scraped = [
    { text: 'cuciqu.pro 2j Tips laundry …', url: 'https://www.threads.com/@x/post/AAA?xmt=1', engagement: 12 },
    { text: 'cuciqu.pro 5j Nota hilang bikin pusing pelanggan ya 3 1', url: undefined, engagement: 4 },
    { text: 'unrelated post text that matches nothing here', engagement: 99 },
  ];
  expect(matchEngagement(posts, scraped)).toEqual([
    { id: '1', engagement: 12 },
    { id: '2', engagement: 4 },
  ]);
});

test('angle hints list the best posts, never zero-engagement ones', () => {
  const hints = angleHints([
    post('1', 'Low post', { engagement: 1, contentType: 'tips' }),
    post('2', 'Best post about nota', { engagement: 30, contentType: 'pain-point' }),
    post('3', 'Zero', { engagement: 0 }),
  ]);
  expect(hints).toMatch(/^Your recent posts that got the most engagement/);
  expect(hints.indexOf('Best post')).toBeLessThan(hints.indexOf('Low post'));
  expect(hints).not.toMatch(/Zero/);
  expect(angleHints([post('3', 'Zero', { engagement: 0 })])).toBe('');
});

test('review fixes: labels in brackets and short punchy posts are allowed', () => {
  expect(qualityIssues('[Tips] Pisahkan cucian putih dan berwarna supaya tidak luntur ya', 'id')).toEqual([]);
  expect(qualityIssues('Kamu tim setrika atau tim lipat? Jawab di komentar 👇', 'id')).toEqual([]);
  expect(qualityIssues('Halo [Nama], ini promo untuk kamu yang ada di sini', 'id').join()).toMatch(/placeholder/);
});

test('review fixes: no second link when the site is already in the text', () => {
  const url = 'https://cuciqu.com/?utm_source=threads';
  expect(appendLink('Cek di cuciqu.com ya', url, 500)).toBe('Cek di cuciqu.com ya');
  expect(appendLink('Cek di https://www.cuciqu.com/harga', url, 500)).toBe('Cek di https://www.cuciqu.com/harga');
});

test('review fixes: unreadable counters are never stored as 0; hints carry no URLs', () => {
  const p = post('1', 'Nota hilang bikin pusing pelanggan ya');
  expect(matchEngagement([p], [{ text: 'Nota hilang bikin pusing pelanggan ya', engagement: undefined }])).toEqual([]);
  expect(angleHints([post('2', 'Best post https://cuciqu.com/?utm_source=threads', { engagement: 5 })])).not.toMatch(/https?:/);
});
