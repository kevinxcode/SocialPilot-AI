import type { QueueItem } from '@/types/models';

type Notify = (title: string, message: string, id?: string, buttons?: { title: string }[]) => void;

/** Autopilot integration points used by the service worker (implemented in Task 13). */
export const autopilotHooks = {
  async ensurePlanned(now: number): Promise<void> {
    void now;
  },
  async replan(now: number): Promise<void> {
    void now;
  },
  async runSlot(item: QueueItem, now: number, ctx: { notify: Notify }): Promise<void> {
    void item;
    void now;
    void ctx;
  },
  async reviewDecision(postId: string, approve: boolean, ctx: { notify: Notify }): Promise<void> {
    void postId;
    void approve;
    void ctx;
  },
};
