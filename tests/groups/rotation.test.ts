import { nextGroup, rankGroups } from '@/services/publishing/groupRotation';
import type { FbGroup, Post, PostStatus } from '@/types/models';

const HOUR = 3600_000;
const NOW = Date.parse('2026-11-23T03:00:00Z');
const group = (id: string, enabled = true) => ({ id, name: id, url: `https://www.facebook.com/groups/${id}`, rules: '', enabled }) as FbGroup;
const post = (groupId: string, status: PostStatus, at: number) =>
  ({
    id: `${groupId}-${status}-${at}`,
    platform: 'fbgroup',
    groupId,
    status,
    updatedAt: at,
    createdAt: at,
    ...(status === 'published' ? { publishedAt: at } : {}),
    ...(status === 'scheduled' ? { scheduledAt: at } : {}),
  }) as Post;

describe('Facebook Group rotation', () => {
  const groups = [group('a'), group('b'), group('c')];

  test('a post waiting for admin approval blocks its group', () => {
    expect(nextGroup(groups, [post('a', 'verifying', NOW - 48 * HOUR)], NOW)?.id).toBe('b');
  });

  test('a failed group goes behind groups that were never tried', () => {
    expect(nextGroup(groups, [post('a', 'failed', NOW - HOUR)], NOW)?.id).toBe('b');
  });

  test('a failed group can still be picked when it is the only one', () => {
    expect(nextGroup([group('a')], [post('a', 'failed', NOW - HOUR)], NOW)?.id).toBe('a');
  });

  test('a group published or scheduled within 24 h is not picked', () => {
    const posts = [post('a', 'published', NOW - HOUR), post('b', 'scheduled', NOW + HOUR), post('c', 'published', NOW - 2 * HOUR)];
    expect(nextGroup(groups, posts, NOW)).toBeUndefined();
  });

  test('drafts and cancelled posts do not use up a turn', () => {
    expect(nextGroup(groups, [post('a', 'draft', NOW), post('a', 'cancelled', NOW)], NOW)?.id).toBe('a');
  });

  test('disabled groups are never picked', () => {
    expect(nextGroup([group('a', false), group('b')], [], NOW)?.id).toBe('b');
  });

  test('a new batch continues after the groups used by the last one', () => {
    const posts = [post('a', 'scheduled', NOW + HOUR), post('b', 'scheduled', NOW + 2 * HOUR)];
    expect(rankGroups(groups, posts).map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });
});
