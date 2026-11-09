import { computeStats } from '@/services/analytics/stats';
import type { Post } from '@/types/models';

const DAY = 86_400_000;
const now = Date.parse('2026-11-10T05:00:00Z');
const p = (id: string, x: Partial<Post>): Post => ({
  id, platform: 'threads', accountId: 'a', text: '', mediaIds: [], status: 'published', fingerprint: id, source: 'manual',
  attempts: 1, createdAt: now - DAY, updatedAt: now - DAY, ...x,
});

test('counts, success rate and per-platform breakdown from own records only', () => {
  const s = computeStats(
    [
      p('1', { publishedAt: now - DAY, contentType: 'tips' }),
      p('2', { platform: 'facebook', publishedAt: now - 2 * DAY, source: 'autopilot', contentType: 'tips' }),
      p('3', { status: 'failed', updatedAt: now - DAY }),
      p('4', { status: 'scheduled', scheduledAt: now + DAY }),
      p('old', { publishedAt: now - 40 * DAY }),
    ],
    { from: now - 7 * DAY, to: now },
    'Asia/Jakarta',
  );
  expect(s.published).toBe(2);
  expect(s.failed).toBe(1);
  expect(s.successRate).toBeCloseTo(2 / 3);
  expect(s.autopilot).toBe(1);
  expect(s.perPlatform.threads.published).toBe(1);
  expect(s.perPlatform.facebook.published).toBe(1);
  expect(s.byContentType.tips).toBe(2);
  expect(s.byDay).toHaveLength(7);
  expect(s.byDay.reduce((a, d) => a + d.published, 0)).toBe(2);
  expect(s.engagement).toBe('N/A');
});

test('no attempts → success rate null, not 0 or 100', () => {
  expect(computeStats([], { from: 0, to: now }, 'Asia/Jakarta').successRate).toBeNull();
});
