/** Which Facebook Group gets the next post. */
import type { FbGroup, Post } from '@/types/models';

const DAY_MS = 24 * 3600_000;

/** Time of a post's latest real attempt; drafts and cancelled posts never used a group's turn. */
function attemptAt(p: Post): number {
  if (p.status === 'draft' || p.status === 'cancelled') return 0;
  if (p.status === 'published') return p.publishedAt ?? p.updatedAt;
  if (p.status === 'scheduled') return p.scheduledAt ?? p.updatedAt;
  return p.updatedAt;
}

const lastAttempt = (groupId: string, posts: Post[]) => Math.max(0, ...posts.filter((p) => p.groupId === groupId).map(attemptAt));

/** Enabled groups, longest without an attempt first. */
export function rankGroups(groups: FbGroup[], posts: Post[]): FbGroup[] {
  const last = new Map(groups.map((g) => [g.id, lastAttempt(g.id, posts)]));
  return groups.filter((g) => g.enabled).sort((a, b) => last.get(a.id)! - last.get(b.id)!);
}

/** A failed attempt only moves a group back in line; live, pending or recent posts make it unavailable. */
function isBlocked(groupId: string, posts: Post[], now: number): boolean {
  return posts.some((p) => {
    if (p.groupId !== groupId) return false;
    if (p.status === 'processing' || p.status === 'verifying') return true;
    return (p.status === 'published' || p.status === 'scheduled') && now - attemptAt(p) < DAY_MS;
  });
}

export function nextGroup(groups: FbGroup[], posts: Post[], now: number): FbGroup | undefined {
  return rankGroups(groups, posts).find((g) => !isBlocked(g.id, posts, now));
}
