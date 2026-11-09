import { ensurePlanned, replan } from '@/services/autopilot/planner';
import { reviewDecision, runSlot } from '@/services/autopilot/runner';
import type { QueueItem } from '@/types/models';

type Notify = (title: string, message: string, id?: string, buttons?: { title: string }[]) => void;

/** Autopilot integration points used by the service worker. */
export const autopilotHooks = {
  ensurePlanned: (now: number) => ensurePlanned(now).then(() => undefined),
  replan: (now: number) => replan(now),
  runSlot: (item: QueueItem, now: number, ctx: { notify: Notify }) => runSlot(item, now, ctx),
  reviewDecision: (postId: string, approve: boolean, ctx: { notify: Notify }) => reviewDecision(postId, approve, ctx),
};
