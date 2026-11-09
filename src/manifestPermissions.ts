export const PERMISSIONS = ['storage', 'alarms', 'notifications', 'tabs', 'scripting', 'unlimitedStorage', 'declarativeNetRequestWithHostAccess', 'tabGroups', 'identity'] as const;
export const HOST_PERMISSIONS = [
  'https://*.threads.net/*',
  'https://*.threads.com/*',
  'https://*.facebook.com/*',
  'https://openrouter.ai/*',
  'https://integrate.api.nvidia.com/*',
  'http://localhost:11434/*',
  // Cloud (Firebase Auth, Firestore, Google Drive)
  'https://identitytoolkit.googleapis.com/*',
  'https://securetoken.googleapis.com/*',
  'https://firestore.googleapis.com/*',
  'https://www.googleapis.com/*',
  'https://oauth2.googleapis.com/*',
] as const;
