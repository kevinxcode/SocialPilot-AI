import { PERMISSIONS, HOST_PERMISSIONS } from '@/manifestPermissions';

test('manifest permissions match Global Constraints exactly', () => {
  expect([...PERMISSIONS].sort()).toEqual(['alarms', 'declarativeNetRequestWithHostAccess', 'identity', 'notifications', 'scripting', 'storage', 'tabGroups', 'tabs', 'unlimitedStorage']);
  expect(HOST_PERMISSIONS).toContain('http://localhost:11434/*');
  expect(HOST_PERMISSIONS).toHaveLength(11);
  for (const h of ['identitytoolkit', 'securetoken', 'firestore', 'www', 'oauth2']) expect(HOST_PERMISSIONS).toContain(`https://${h}.googleapis.com/*`);
});
