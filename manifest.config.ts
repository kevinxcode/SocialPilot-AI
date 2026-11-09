import { defineManifest } from '@crxjs/vite-plugin';

import { PERMISSIONS, HOST_PERMISSIONS } from './src/manifestPermissions';

// Same extension ID on every laptop (needed for the Google sign-in redirect): set EXTENSION_KEY when building.
const key = process.env.EXTENSION_KEY?.trim();

export default defineManifest({
  ...(key ? { key } : {}),
  manifest_version: 3,
  name: 'SocialPilot AI',
  version: '0.1.0',
  description: 'AI content studio and scheduled publishing to Threads and a Facebook Page.',
  permissions: [...PERMISSIONS],
  host_permissions: [...HOST_PERMISSIONS],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  options_page: 'src/dashboard/index.html',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'SocialPilot AI',
    default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' },
  },
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
});
