/**
 * SocialPilot account = Firebase Authentication with email + password, through the REST API so it also works in the
 * MV3 service worker. There is no sign-up screen: the owner creates the account once in the Firebase Console.
 * The refresh token is kept in chrome.storage.local of this device only (never in Firestore, never logged).
 */
import { getCloudConfig, getSession, setSession, type CloudSession } from './config';

export class CloudAuthError extends Error {
  name = 'CloudAuthError';
}

type Fetch = typeof fetch;

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';

/** Firebase error codes → a message the user can act on. */
export function authMessage(code: string): string {
  const c = code.split(/[ :]/)[0];
  switch (c) {
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
    case 'EMAIL_NOT_FOUND':
      return 'Wrong email or password';
    case 'INVALID_EMAIL':
      return 'That is not a valid email address';
    case 'USER_DISABLED':
      return 'This account has been disabled in Firebase';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts — wait a few minutes and try again';
    case 'OPERATION_NOT_ALLOWED':
    case 'PASSWORD_LOGIN_DISABLED':
      return 'Email/Password sign-in is not enabled in the Firebase project (see docs/SETUP-CLOUD.md)';
    case 'MISSING_PASSWORD':
      return 'Enter your password';
    default:
      return `Sign-in failed (${code})`;
  }
}

async function call<T>(f: Fetch, apiKey: string, path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await f(`${IDENTITY}/${path}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CloudAuthError('No connection to Firebase — check your internet connection');
  }
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new CloudAuthError(authMessage(j.error?.message ?? String(r.status)));
  return j;
}

/** Email + password sign-in. */
export async function signIn(email: string, password: string, f: Fetch = fetch, now = Date.now()): Promise<CloudSession> {
  const cfg = await getCloudConfig();
  if (!cfg) throw new CloudAuthError('Fill in the Firebase settings first');
  if (!email.trim()) throw new CloudAuthError('Enter your email');
  if (!password) throw new CloudAuthError('Enter your password');
  const j = await call<{ localId: string; email: string; idToken: string; refreshToken: string; expiresIn: string }>(f, cfg.apiKey, 'accounts:signInWithPassword', {
    email: email.trim(),
    password,
    returnSecureToken: true,
  });
  const s: CloudSession = { uid: j.localId, email: j.email, idToken: j.idToken, refreshToken: j.refreshToken, idExpiresAt: now + Number(j.expiresIn) * 1000 };
  await setSession(s);
  return s;
}

/** Sends Firebase's "reset your password" email. */
export async function sendPasswordReset(email: string, f: Fetch = fetch): Promise<void> {
  const cfg = await getCloudConfig();
  if (!cfg) throw new CloudAuthError('Fill in the Firebase settings first');
  if (!email.trim()) throw new CloudAuthError('Enter your email first');
  await call(f, cfg.apiKey, 'accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: email.trim() });
}

export async function signOut(): Promise<void> {
  await setSession(null);
}

/** Valid Firebase ID token (refreshed 5 min before expiry). Throws when signed out. */
export async function idToken(f: Fetch = fetch, now = Date.now()): Promise<{ token: string; uid: string }> {
  const s = await getSession();
  const cfg = await getCloudConfig();
  if (!s || !cfg) throw new CloudAuthError('Not signed in to the cloud');
  if (s.idExpiresAt - now > 5 * 60_000) return { token: s.idToken, uid: s.uid };
  const r = await f(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
  });
  const j = (await r.json()) as { id_token?: string; refresh_token?: string; expires_in?: string; error?: { message: string } };
  if (!r.ok || !j.id_token) throw new CloudAuthError(`Session expired — sign in again (${j.error?.message ?? r.status})`);
  await setSession({ ...s, idToken: j.id_token, refreshToken: j.refresh_token ?? s.refreshToken, idExpiresAt: now + Number(j.expires_in ?? 3600) * 1000 });
  return { token: j.id_token, uid: s.uid };
}
