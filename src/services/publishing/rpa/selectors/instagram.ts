import type { PlatformSelectors } from './types';

/**
 * Instagram web (www.instagram.com) selectors for FEED posts, English + Indonesian.
 * Flow: Create → Post → file → Next (crop) → Next (edit) → caption → Share.
 * Stories cannot be created on desktop Instagram, so they are not supported here.
 * Update `version` whenever anything changes and re-run a Dry run on your account.
 */
export const INSTAGRAM: PlatformSelectors = {
  platform: 'instagram',
  version: '2026-11-10.7',
  loggedOut: [{ css: 'input[name="username"]' }, { css: 'form#loginForm' }, { css: 'a[href^="/accounts/login"]', text: '^(log in|masuk)$' }],
  // Only the owner sees "Edit profile" on the profile page.
  ownProfileProof: [
    { css: 'a[href="/accounts/edit/"]' },
    { css: 'a[role="link"], a, div[role="button"], button', text: '^(edit profile|edit profil)$' },
  ],
  composerOpen: [
    { css: 'a[role="link"], a, div[role="button"], span', label: '^(new post|create|buat|postingan baru|buat baru)$' },
    { css: 'a[role="link"], div[role="button"]', text: '^(create|buat)$' },
  ],
  createMenuItem: [
    { css: 'a[role="link"], a, div[role="button"], span', label: '^(post|postingan|kiriman)$' },
    { css: 'a[role="link"], a, div[role="button"], span', text: '^(post|postingan|kiriman)$' },
  ],
  composerDialog: [{ css: 'div[role="dialog"]', label: '(create new post|buat postingan baru|crop|pangkas|edit)' }, { css: 'div[role="dialog"]' }],
  textbox: [
    { css: 'div[contenteditable="true"][role="textbox"]', label: '(write a caption|tulis keterangan|caption|keterangan)' },
    // instagram.com (seen 2026-11-10): the caption box is a contenteditable WITHOUT role="textbox"
    { css: '[contenteditable="true"]', label: '(write a caption|add a caption|tulis keterangan|tambahkan keterangan|caption|keterangan)' },
    { css: 'div[contenteditable="true"][role="textbox"]' },
    { css: 'div[contenteditable="true"]' },
    { css: 'textarea' },
  ],
  mediaButton: [{ css: 'button, div[role="button"]', text: '^(select from computer|pilih dari komputer)$' }],
  fileInput: [{ css: 'input[type="file"][accept*="image"]' }, { css: 'input[type="file"]' }],
  mediaPreview: [{ css: 'img[src^="blob:"]' }, { css: 'video' }, { css: 'div[style*="blob:"]' }],
  nextButton: [{ css: 'div[role="button"], button', text: '^(next|berikutnya|selanjutnya)$' }],
  reelsNoticeOk: [{ css: 'button, div[role="button"]', text: '^(ok|oke)$' }],
  postButton: [{ css: 'div[role="button"], button', text: '^(share|bagikan)$' }],
  sharedNotice: [
    { css: 'span, div, h2, h3', text: '(your (post|reel) has been shared|post shared|reel shared|postingan anda telah dibagikan|postingan telah dibagikan|reel anda telah dibagikan)' },
  ],
  shareError: [{ css: 'span, div, h2, h3', text: "(couldn't be shared|could not be shared|tidak dapat dibagikan|gagal dibagikan|something went wrong|terjadi kesalahan)" }],
  postContainer: 'article, main',
  permalink: '/(p|reel)/[A-Za-z0-9_-]+',
};
