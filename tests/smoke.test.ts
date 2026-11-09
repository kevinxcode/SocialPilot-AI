import { PERMISSIONS, HOST_PERMISSIONS } from '@/manifestPermissions';

test('manifest permissions match Global Constraints exactly', () => {
  expect([...PERMISSIONS].sort()).toEqual(['alarms', 'declarativeNetRequestWithHostAccess', 'notifications', 'scripting', 'storage', 'tabs', 'unlimitedStorage']);
  expect(HOST_PERMISSIONS).toContain('http://localhost:11434/*');
  expect(HOST_PERMISSIONS).toHaveLength(6);
});
