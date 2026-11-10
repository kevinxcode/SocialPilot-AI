import { noLinkPlatform, stripLinks } from '@/services/content/noLinks';
import { db } from '@/services/storage/db';
import { uid } from '@/lib/utils';
import type { Platform, Post, ProviderId } from '@/types/models';
import { fingerprint } from './fingerprint';
import { getSettings } from '@/services/storage/settings';
import { pickMedia } from '@/services/media/pick';

export interface NewPost {
  platform: Platform;
  text: string;
  brandId?: string;
  title?: string;
  mediaIds?: string[];
  source?: Post['source'];
  contentType?: string;
  providerId?: ProviderId;
  modelId?: string;
  groupId?: string;
  /** pick an image automatically when mediaIds is empty (default: settings.autoPickMedia) */
  autoMedia?: boolean;
}

export function mediaTags(contentType?: string, title?: string): string[] {
  return [contentType ?? '', ...(contentType ?? '').split('-'), ...(title ?? '').toLowerCase().split(/\s+/)].filter((t) => t.length > 1);
}

export async function accountFor(platform: Platform) {
  return db.accounts.where('platform').equals(platform).first();
}

export async function createDraft(p: NewPost): Promise<Post> {
  const now = Date.now();
  const acc = p.platform === 'fbgroup' ? undefined : await accountFor(p.platform);
  let mediaIds = p.mediaIds ?? [];
  if (!mediaIds.length && (p.autoMedia ?? (await getSettings()).autoPickMedia)) {
    const m = await pickMedia(mediaTags(p.contentType, p.title));
    if (m) mediaIds = [m.id];
  }
  // The fingerprint must describe the text that is really posted (links removed), or the feed check cannot find it.
  const text = noLinkPlatform(p.platform) ? stripLinks(p.text) : p.text;
  const post: Post = {
    id: uid(),
    platform: p.platform,
    accountId: acc?.id ?? '',
    brandId: p.brandId,
    title: p.title,
    text,
    mediaIds,
    groupId: p.groupId,
    status: 'draft',
    fingerprint: fingerprint(text),
    source: p.source ?? 'manual',
    attempts: 0,
    contentType: p.contentType,
    providerId: p.providerId,
    modelId: p.modelId,
    createdAt: now,
    updatedAt: now,
  };
  await db.posts.add(post);
  return post;
}

export async function updatePostText(id: string, text: string): Promise<void> {
  const post = await db.posts.get(id);
  const sent = post && noLinkPlatform(post.platform) ? stripLinks(text) : text;
  await db.posts.update(id, { text: sent, fingerprint: fingerprint(sent), updatedAt: Date.now() });
}
