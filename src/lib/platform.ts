import type { Platform } from '@/types/models';

export const PLATFORM_LABEL: Record<Platform, string> = { threads: 'Threads', facebook: 'Facebook Page', fbgroup: 'Facebook Group', instagram: 'Instagram' };
export const platformLabel = (p: Platform) => PLATFORM_LABEL[p];
