import { defineManifest } from '@crxjs/vite-plugin';

import { PERMISSIONS, HOST_PERMISSIONS } from './src/manifestPermissions';

// Same extension ID on every laptop (needed for the Google sign-in redirect): set EXTENSION_KEY when building.
// Public key (not a secret): gives the same extension ID (mdjihdkmmmghahnaknndeohgkelicoee) on every computer.
const envKey = process.env.EXTENSION_KEY?.trim();
// EXTENSION_KEY=none builds WITHOUT a key (keeps the old, folder-based ID — used once to export a backup).
const key = envKey === 'none' ? '' : envKey || 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8A6rDvsEKErH82FwmsSKRg4Z8BN/5/6i2k0ZANqEYKpqwQ3x9yFk49jyl2L0K/wjnA4EP2iqMQIDEGLk4tSZgyaVC2r32Y6qWWEyan3T7mtut7rl8I0L8Wh5ZPiWJbZJrtHnW6VlNChdH90QBzbDPgRO1w0hS+kuCyc/ErL4uhe4KgSfQkmRVIPGc1Wgo7isVckt++PZenH4F2M5i82dscYvtAgFRxxudMeQPzCfc5bV7+HZkG6Yta9MyJl7yqmr0iRaZpAEF8f/CrvejBh3jc8HdWBSFhObGfajX01TNOtS9tBlIeM/1a8UF7V0hqZwx9OYfvRSBRZ0JbkRIW+lqQIDAQAB';

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
