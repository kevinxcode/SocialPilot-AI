import { FACEBOOK } from './facebook';
import type { PlatformSelectors } from './types';

/**
 * Facebook Group (www.facebook.com/groups/<id>) selectors, English + Indonesian.
 * Members see a "Write something..." composer; non-members see "Join group".
 */
export const FBGROUP: PlatformSelectors = {
  ...FACEBOOK,
  platform: 'fbgroup',
  version: '2026-11-09.1',
  switchToPage: undefined,
  ownProfileProof: [{ css: 'div[role="button"], span', text: '^(write something|tulis sesuatu|create a public post|buat postingan publik)' }],
  notMember: [{ css: 'div[role="button"], a[role="button"]', text: '^(join group|gabung ke grup|gabung grup|bergabung dengan grup)$' }],
  composerOpen: [{ css: 'div[role="button"]', text: '^(write something|tulis sesuatu|create a public post|buat postingan publik)' }],
  pendingNotice: [
    {
      css: '[role="alert"], [role="status"], [role="dialog"], span, div',
      text: '(pending approval|pending admin|is pending|awaiting approval|submitted for (admin )?(approval|review)|admins? will review|menunggu persetujuan|menunggu tinjauan|dikirim ke admin|akan ditinjau|ditinjau oleh admin)',
    },
  ],
  permalink: '/groups/[^/]+/(posts|permalink)/',
};
