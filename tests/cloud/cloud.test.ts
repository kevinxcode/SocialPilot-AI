import { open, seal, WrongPassphraseError } from '@/services/cloud/crypto';
import { authMessage, idToken, sendPasswordReset, signIn } from '@/services/cloud/auth';
import { getSession } from '@/services/cloud/config';
import { setCloudConfig, setSession } from '@/services/cloud/config';
import { changedSince, putRecordIfNewer, setMeta } from '@/services/cloud/firestore';
import { settingsForCloud, settingsFromCloud } from '@/services/cloud/sync';
import { holdsPublisherLease, LEASE_MS } from '@/services/cloud/leader';
import { DEFAULT_SETTINGS } from '@/services/storage/settings';
import { resetDb } from '@/services/storage/db';
import type { Settings } from '@/types/models';

const CFG = { apiKey: 'AIzaTEST', projectId: 'sp-test' };
const NOW = Date.parse('2026-11-10T03:00:00Z');

beforeEach(async () => {
  await resetDb();
  await chrome.storage.local.clear();
});

async function signedIn() {
  await setCloudConfig(CFG);
  await setSession({ uid: 'u1', email: 'a@b.c', idToken: 'ID', refreshToken: 'RT', idExpiresAt: Date.now() + 3600_000 });
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

describe('email/password sign-in', () => {
  test('signs in with email + password and stores the session', async () => {
    await setCloudConfig(CFG);
    const f = vi.fn(async () => resp(200, { localId: 'u1', email: 'me@x.id', idToken: 'ID', refreshToken: 'RT', expiresIn: '3600' }));
    const s = await signIn(' me@x.id ', 'pw123456', f as never, NOW);
    expect(s).toMatchObject({ uid: 'u1', email: 'me@x.id', idExpiresAt: NOW + 3600_000 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaTEST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'me@x.id', password: 'pw123456', returnSecureToken: true });
    expect((await getSession())?.refreshToken).toBe('RT');
  });

  test('wrong password → clear message, no session', async () => {
    await setCloudConfig(CFG);
    const f = vi.fn(async () => resp(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } }));
    await expect(signIn('me@x.id', 'nope', f as never)).rejects.toThrow('Wrong email or password');
    expect(await getSession()).toBeNull();
    expect(authMessage('TOO_MANY_ATTEMPTS_TRY_LATER : Access disabled')).toMatch(/Too many attempts/);
  });

  test('password reset email is requested from Firebase', async () => {
    await setCloudConfig(CFG);
    const f = vi.fn(async () => resp(200, { email: 'me@x.id' }));
    await sendPasswordReset('me@x.id', f as never);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('accounts:sendOobCode');
    expect(JSON.parse(String(init.body))).toEqual({ requestType: 'PASSWORD_RESET', email: 'me@x.id' });
  });

  test('the Firebase ID token is refreshed before it expires', async () => {
    await signedIn();
    await setSession({ uid: 'u1', email: 'a@b.c', idToken: 'OLD', refreshToken: 'RT', idExpiresAt: NOW + 60_000 });
    const f = vi.fn(async () => resp(200, { id_token: 'NEW', refresh_token: 'RT2', expires_in: '3600' }));
    expect(await idToken(f as never, NOW)).toEqual({ token: 'NEW', uid: 'u1' });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('securetoken.googleapis.com');
  });
});

describe('Firestore REST', () => {
  test('a record is written with compare-and-set + server time, and read back by server time', async () => {
    await signedIn();
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(':runQuery'))
        return resp(200, [{ document: { name: 'x', fields: { table: { stringValue: 'posts' }, id: { stringValue: 'p1' }, json: { stringValue: '{"id":"p1"}' }, ts: { integerValue: '5' }, deleted: { booleanValue: false }, serverTs: { timestampValue: '2026-11-10T03:00:00Z' } } } }]);
      if (url.includes(':commit')) return resp(200, { writeResults: [{}] });
      if (!init || init.method === 'GET') return resp(404, { error: { message: 'NOT_FOUND' } });
      return resp(200, {});
    });
    expect(await putRecordIfNewer({ table: 'posts', id: 'p1', json: '{}', ts: 5, deleted: false }, f as never)).toEqual({ result: 'written' });
    const commit = f.mock.calls.find((c) => String(c[0]).includes(':commit')) as unknown as [string, RequestInit];
    const body = JSON.parse(String(commit[1].body));
    expect(body.writes[0].currentDocument).toEqual({ exists: false });
    expect(body.writes[0].updateTransforms).toEqual([{ fieldPath: 'serverTs', setToServerValue: 'REQUEST_TIME' }]);
    expect(body.writes[0].update.name).toMatch(/users\/u1\/records\/posts__cDE$/);
    expect((commit[1].headers as Record<string, string>).Authorization).toBe('Bearer ID');
    expect(await changedSince('', 300, f as never)).toEqual([{ table: 'posts', id: 'p1', json: '{"id":"p1"}', ts: 5, deleted: false, serverTs: '2026-11-10T03:00:00Z' }]);
  });

  test('an older edit never overwrites a newer cloud copy', async () => {
    await signedIn();
    const f = vi.fn(async (url: string) =>
      url.includes(':commit')
        ? resp(200, {})
        : resp(200, { name: 'x', updateTime: 'U1', fields: { table: { stringValue: 'posts' }, id: { stringValue: 'p1' }, json: { stringValue: '{"status":"published"}' }, ts: { integerValue: '10' }, deleted: { booleanValue: false } } }),
    );
    const r = await putRecordIfNewer({ table: 'posts', id: 'p1', json: '{"status":"scheduled"}', ts: 5, deleted: false }, f as never);
    expect(r.result).toBe('remote-newer');
    expect(f.mock.calls.some((c) => String(c[0]).includes(':commit'))).toBe(false);
  });

  test('a 404 on a write is an error, never a silent success', async () => {
    await signedIn();
    const f = vi.fn(async () => resp(404, { error: { message: 'database not found' } }));
    await expect(setMeta('x', {}, undefined, f as never)).rejects.toThrow(/404/);
  });

  test('compare-and-set: a failed precondition returns false', async () => {
    await signedIn();
    const f = vi.fn(async () => resp(400, { error: { message: 'FAILED_PRECONDITION' } }));
    expect(await setMeta('publisher', {}, '2026-01-01T00:00:00Z', f as never)).toBe(false);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('currentDocument.updateTime=');
  });
});

describe('one publishing device', () => {
  const api = (lease: { deviceId: string; until: number } | null, setOk = true, handover: { to: string; at: number } | null = null) => ({
    get: vi.fn(async (name: string) =>
      name === 'publisher' ? (lease ? { value: { ...lease, label: 'x' }, updateTime: 'T1' } : null) : handover ? { value: handover, updateTime: 'H' } : null,
    ) as never,
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


describe('handover between devices', () => {
  const make = (state: { lease: { deviceId: string; until: number; label: string } | null; handover: { to: string; at: number } | null }) => ({
    get: vi.fn(async (name: string) => {
      const v = name === 'publisher' ? state.lease : state.handover;
      return v ? { value: v, updateTime: 'T' } : null;
    }) as never,
    set: vi.fn(async (name: string, value: never) => {
      if (name === 'publisher') state.lease = value;
      else state.handover = value;
      return true;
    }) as never,
  });

  test('the publisher releases the lease when another device asks, and stops publishing', async () => {
    await signedIn();
    const { deviceId } = await import('@/services/cloud/config');
    const me = await deviceId();
    const state = { lease: { deviceId: me, until: NOW + 60_000, label: 'me' }, handover: { to: 'laptop-2', at: NOW - 1000 } };
    expect(await holdsPublisherLease(NOW, make(state))).toBe(false);
    expect(state.lease.until).toBe(0); // released → laptop-2 can take it at once
  });

  test('takeOver is immediate when free, only a request while another device holds the lease', async () => {
    await signedIn();
    const { takeOver } = await import('@/services/cloud/leader');
    const busy = { lease: { deviceId: 'other', until: NOW + 60_000, label: 'o' }, handover: null };
    expect(await takeOver(NOW, make(busy))).toBe('requested');
    expect(busy.lease.deviceId).toBe('other'); // never snatched in the middle of a post
    const free = { lease: null, handover: null };
    expect(await takeOver(NOW, make(free))).toBe('now');
  });
});
