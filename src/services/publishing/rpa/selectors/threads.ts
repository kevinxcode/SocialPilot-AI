import type { PlatformSelectors } from './types';

/**
 * Threads (threads.com / threads.net) web UI selectors, English + Indonesian.
 * Update SELECTORS_VERSION whenever you change anything here and re-run the dry-run test.
 */
export const THREADS: PlatformSelectors = {
  platform: 'threads',
  version: '2026-11-09.2',
  loggedOut: [
    { css: 'a[href^="/login"]' },
    { css: 'a[role="link"], div[role="button"]', text: '^(log in|masuk|log in with instagram|lanjutkan dengan instagram)$' },
  ],
  ownProfileProof: [{ css: 'div[role="button"], a[role="link"], button', text: '^(edit profile|edit profil)$' }],
  composerOpen: [
    { css: 'div[role="button"], a[role="link"], a, button', label: '^(create|buat|new thread|thread baru|utas baru|buat utas|create post|buat postingan)$' },
    { css: 'div[role="button"]', text: "^(what's new\\?|apa yang baru\\?|start a thread|mulai utas)" },
  ],
  composerDialog: [{ css: 'div[role="dialog"]' }],
  textbox: [{ css: 'div[contenteditable="true"][role="textbox"]' }, { css: 'div[contenteditable="true"]' }],
  mediaButton: [{ css: 'div[role="button"], button', label: '^(attach media|lampirkan media)$' }],
  fileInput: [{ css: 'input[type="file"]' }],
  mediaPreview: [{ css: 'img[src^="blob:"]' }, { css: 'video' }],
  postButton: [{ css: 'div[role="button"], button', text: '^(post|posting|kirim)$' }],
  postContainer: 'div[data-pressable-container="true"]',
  permalink: '/@[^/]+/post/[A-Za-z0-9_-]+',
};
