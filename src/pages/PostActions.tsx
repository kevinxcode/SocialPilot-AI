import type { Platform } from '@/types/models';

export interface PostActionsProps {
  text: string;
  platform: Platform;
  brandId: string;
  title?: string;
  contentType?: string;
  disabled?: boolean;
  onDone?: () => void;
}

/** Schedule / Publish now / attach media — implemented with the queue in Task 12. */
export function PostActions(props: PostActionsProps) {
  void props;
  return null;
}
