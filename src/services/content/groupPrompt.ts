import type { FbGroup } from '@/types/models';

/** Prompt instructions for a Facebook Group post (community tone + the group's own rules). */
export function groupInstructions(g: FbGroup): string {
  return [
    `This post goes to the Facebook Group "${g.name}". Write for the community: helpful and educational, not a sales pitch.`,
    'Invite discussion (end with a question). Mention the brand at most once, softly.',
    g.rules.trim() ? `Group rules you MUST follow: ${g.rules.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
