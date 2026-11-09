import { open, seal, WrongPassphraseError } from '@/services/cloud/crypto';
import { authUrl, parseRedirect, idToken } from '@/services/cloud/auth';
import { setCloudConfig, setSession } from '@/services/cloud/config';
import { changedSince, putRecord, setMeta } from '@/services/cloud/firestore';
import { settingsForCloud, settingsFromCloud } from '@/services/cloud/sync';
import { holdsPublisherLease, LEASE_MS } from '@/services/cloud/leader';
import { mediaBlob } from '@/services/cloud/drive';
import { DEFAULT_SETTINGS } from '@/services/storage/settings';
import { db, resetDb } from '@/services/storage/db';
import type { Settings } from '@/types/models';

const CFG = { apiKey: 'AIzaTEST', projectId: 'sp-test', clientId: 'cid.apps.googleusercontent.com' };
const NOW = Date.parse('2026-11-10T03:00:00Z');

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

async function signedIn() {
  await setCloudConfig(CFG);
  await setSession({ uid: 'u1', email: 'a@b.c', idToken: 'ID', refreshToken: 'RT', idExpiresAt: Date.now() + 3600_000, googleToken: 'GT', googleExpiresAt: Date.now() + 3600_000 });
}

const resp = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('encryption of API keys', () => {
  test('round trip; wrong passphrase is rejected; ciphertext does not contain the key', async () => {
    const s = await seal({ nvidia: 'nvapi-SECRET' }, 'correct horse');
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(await open(s, 'correct horse')).toEqual({ nvidia: 'nvapi-SECRET' });
    await expect(open(s, 'wrong pass!')).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(seal({}, 'short')).rejects.toThrow(/8 characters/);
  });

  test('settings go to the cloud without any plain API key, and come back with them', async () => {
    const local: Settings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, nvidia: { ...DEFAULT_SETTINGS.providers.nvidia, apiKey: 'nvapi-SECRET' } } };
    const up = await settingsForCloud(local, 'correct horse');
    expect(JSON.stringify(up)).not.toContain('nvapi-SECRET');
    expect(up.sealedKeys).toBeDefined();
    const other: Settings = { ...DEFAULT_SETTINGS };
    const back = await settingsFromCloud(up, other, 'correct horse');
    expect(back.keysLocked).toBe(false);
    expect(back.settings.providers.nvidia.apiKey).toBe('nvapi-SECRET');
    // Without / with a wrong passphrase: keys stay locked, local keys are kept, nothing crashes.
    const locked = await settingsFromCloud(up, { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, nvidia: { ...DEFAULT_SETTINGS.providers.nvidia, apiKey: 'mine' } } }, 'wrong pass!');
    expect(locked.keysLocked).toBe(true);
    expect(locked.settings.providers.nvidia.apiKey).toBe('mine');
  });

  test('no passphrase → keys are simply not uploaded', async () => {
    const local: Settings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, nvidia: { ...DEFAULT_SETTINGS.providers.nvidia, apiKey: 'nvapi-SECRET' } } };
    const up = await settingsForCloud(local, null);
    expect(JSON.stringify(up)).not.toContain('nvapi-SECRET');
    expect(up.sealedKeys).toBeUndefined();
  });
});

describe('Google sign-in', () => {
  test('auth URL asks only for profile + drive.file; redirect is parsed', () => {
    const u = new URL(authUrl(CFG, 'https://abc.chromiumapp.org/', true));
    expect(u.searchParams.get('scope')).toBe('openid email profile https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('response_type')).toBe('token');
    expect(parseRedirect('https://abc.chromiumapp.org/#access_token=T&expires_in=3599')).toEqual({ token: 'T', expiresIn: 3599 });
    expect(() => parseRedirect('https://abc.chromiumapp.org/#error=access_denied')).toThrow(/access_denied/);
  });

  test('the Firebase ID token is refreshed before it expires', async () => {
    await signedIn();
    await setSession({ uid: 'u1', email: 'a@b.c', idToken: 'OLD', refreshToken: 'RT', idExpiresAt: NOW + 60_000, googleToken: 'GT', googleExpiresAt: NOW + 3600_000 });
    const f = vi.fn(async () => resp(200, { id_token: 'NEW', refresh_token: 'RT2', expires_in: '3600' }));
    expect(await idToken(f as never, NOW)).toEqual({ token: 'NEW', uid: 'u1' });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('securetoken.googleapis.com');
  });
});

describe('Firestore REST', () => {
  test('records are written under users/{uid} and read back by ts', async () => {
    await signedIn();
    const f = vi.fn(async (url: string) =>
      url.includes(':runQuery')
        ? resp(200, [{ document: { name: 'x', fields: { table: { stringValue: 'posts' }, id: { stringValue: 'p1' }, json: { stringValue: '{"id":"p1"}' }, ts: { integerValue: '5' }, deleted: { booleanValue: false } } } }])
        : resp(200, {}),
    );
    await putRecord({ table: 'posts', id: 'p1', json: '{}', ts: 5, deleted: false }, f as never);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://firestore.googleapis.com/v1/projects/sp-test/databases/(default)/documents/users/u1/records/posts__p1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ID');
    expect(await changedSince(0, 300, f as never)).toEqual([{ table: 'posts', id: 'p1', json: '{"id":"p1"}', ts: 5, deleted: false }]);
  });

  test('compare-and-set: a failed precondition returns false', async () => {
    await signedIn();
    const f = vi.fn(async () => resp(400, { error: { message: 'FAILED_PRECONDITION' } }));
    expect(await setMeta('publisher', {}, '2026-01-01T00:00:00Z', f as never)).toBe(false);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('currentDocument.updateTime=');
  });
});

describe('one publishing device', () => {
  const api = (lease: { deviceId: string; until: number } | null, setOk = true) => ({
    get: vi.fn(async () => (lease ? { value: { ...lease, label: 'x' }, updateTime: 'T1' } : null)) as never,
    set: vi.fn(async () => setOk) as never,
  });

  test('signed out → this device publishes (local mode)', async () => {
    expect(await holdsPublisherLease(NOW, api(null))).toBe(true);
  });

  test('free lease is taken; a live lease of another device blocks; an expired one is taken over', async () => {
    await signedIn();
    expect(await holdsPublisherLease(NOW, api(null))).toBe(true);
    expect(await holdsPublisherLease(NOW, api({ deviceId: 'other', until: NOW + 60_000 }))).toBe(false);
    const a = api({ deviceId: 'other', until: NOW - 1 });
    expect(await holdsPublisherLease(NOW, a)).toBe(true);
    expect((a.set as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('T1'); // compare-and-set on the read version
  });

  test('losing the race → not publishing; cloud error → only keeps a lease it recently held', async () => {
    await signedIn();
    expect(await holdsPublisherLease(NOW, api(null, false))).toBe(false);
    const broken = { get: vi.fn(async () => { throw new Error('offline'); }) as never, set: vi.fn() as never };
    expect(await holdsPublisherLease(NOW + 1000, broken)).toBe(false); // last answer was "not publishing"
    expect(await holdsPublisherLease(NOW + 2000, api(null))).toBe(true);
    expect(await holdsPublisherLease(NOW + 3000, broken)).toBe(true);
    expect(await holdsPublisherLease(NOW + LEASE_MS, broken)).toBe(false); // never longer than the lease
  });
});

test('a media file that only exists in Drive is downloaded once and cached', async () => {
  await signedIn();
  await db.media.add({ id: 'm1', name: 'a.png', type: 'image/png', size: 1, tags: [], usedCount: 0, createdAt: 1, driveFileId: 'F1' });
  const f = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
  const m = (await db.media.get('m1'))!;
  const b = await mediaBlob(m, f as never);
  expect(await b!.text()).toBe('png');
  expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://www.googleapis.com/drive/v3/files/F1?alt=media');
  expect((await db.media.get('m1'))?.blob).toBeDefined();
});
