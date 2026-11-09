import { db } from '@/services/storage/db';
import { uid } from '@/lib/utils';
import type { Platform, Post, ProviderId } from '@/types/models';
import { fingerprint } from './fingerprint';

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
}

export async function accountFor(platform: Platform) {
  return db.accounts.where('platform').equals(platform).first();
}

export async function createDraft(p: NewPost): Promise<Post> {
  const now = Date.now();
  const acc = await accountFor(p.platform);
  const post: Post = {
    id: uid(),
    platform: p.platform,
    accountId: acc?.id ?? '',
    brandId: p.brandId,
    title: p.title,
    text: p.text,
    mediaIds: p.mediaIds ?? [],
    status: 'draft',
    fingerprint: fingerprint(p.text),
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
  await db.posts.update(id, { text, fingerprint: fingerprint(text), updatedAt: Date.now() });
}
