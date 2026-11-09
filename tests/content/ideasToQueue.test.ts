import { spreadTimes } from '@/services/content/ideasToQueue';

const H = 3600_000;
test('spreadTimes spaces by gap and stays inside the window (WIB)', () => {
  const start = Date.parse('2026-11-09T10:00:00Z'); // 17:00 WIB
  const t = spreadTimes(start, 4, H, 'Asia/Jakarta', '09:00', '19:00');
  const wib = t.map((x) => new Date(x + 7 * H).toISOString().slice(0, 16));
  expect(wib).toEqual(['2026-11-09T17:00', '2026-11-09T18:00', '2026-11-09T19:00', '2026-11-10T09:00']);
});

test('before the window starts → moves to window start', () => {
  const start = Date.parse('2026-11-09T00:00:00Z'); // 07:00 WIB
  expect(new Date(spreadTimes(start, 1, H, 'Asia/Jakarta', '09:00', '19:00')[0] + 7 * H).toISOString().slice(11, 16)).toBe('09:00');
});
