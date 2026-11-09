import type { PlatformSelectors } from './types';

/**
 * Facebook Page (www.facebook.com/<page>) selectors, English + Indonesian.
 * The Page composer ("What's on your mind?") only appears when acting as the Page;
 * visitors see "Write something to <Page>…", which preflight treats as a failure.
 */
export const FACEBOOK: PlatformSelectors = {
  platform: 'facebook',
  version: '2026-11-09.1',
  loggedOut: [{ css: 'form#login_form' }, { css: 'input[name="email"]' }, { css: 'form[action*="/login"]' }],
  ownProfileProof: [
    // "What's on your mind, CuciQu Pro?" — the Page name is often included
    { css: 'div[role="button"], span', text: "^(what's on your mind|apa yang anda pikirkan|apa yang kamu pikirkan)" },
  ],
  switchToPage: [{ css: 'div[role="button"], a[role="button"]', text: '^(switch now|switch|beralih sekarang|beralih)$' }],
  composerOpen: [
    { css: 'div[role="button"]', text: "^(what's on your mind|apa yang anda pikirkan|apa yang kamu pikirkan)" },
    { css: 'div[role="button"]', text: '^(create post|buat postingan)$' },
  ],
  composerDialog: [{ css: 'div[role="dialog"]', label: '^(create post|buat postingan)$' }, { css: 'div[role="dialog"]' }],
  textbox: [{ css: 'div[contenteditable="true"][role="textbox"]' }],
  mediaButton: [{ css: 'div[role="button"]', label: '^(photo/video|foto/video)$' }],
  fileInput: [{ css: 'input[type="file"][accept*="image"]' }, { css: 'input[type="file"]' }],
  mediaPreview: [{ css: 'img[src^="blob:"]' }, { css: 'img[src^="data:"]' }, { css: 'video' }],
  nextButton: [{ css: 'div[role="button"]', label: '^(next|berikutnya|selanjutnya)$' }],
  postButton: [
    { css: 'div[role="button"]', label: '^(post|posting|kirim)$' },
    { css: 'div[role="button"]', text: '^(post|posting|kirim)$' },
  ],
  postContainer: 'div[role="article"]',
  permalink: '(/posts/|story_fbid=|/permalink/|pfbid)',
};
