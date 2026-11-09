/**
 * "Login with Google" for the extension (Chrome and Edge): Google OAuth via chrome.identity.launchWebAuthFlow,
 * then Firebase Auth REST (signInWithIdp). Uses the REST APIs so it also works in the MV3 service worker.
 * Scopes: openid email profile + drive.file (only files this extension creates in Drive).
 */
import { getCloudConfig, getSession, setSession, type CloudConfig, type CloudSession } from './config';

export const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];

export class CloudAuthError extends Error {
  name = 'CloudAuthError';
}

type Fetch = typeof fetch;

/** Builds the Google OAuth URL (implicit flow: the access token comes back in the redirect fragment). */
export function authUrl(cfg: CloudConfig, redirectUri: string, interactive: boolean, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    ...(interactive ? { prompt: 'consent select_account' } : { prompt: 'none' }),
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Reads access_token / expires_in from the redirect URL fragment. */
export function parseRedirect(url: string): { token: string; expiresIn: number } {
  const h = new URLSearchParams(new URL(url).hash.slice(1));
  const err = h.get('error');
  if (err) throw new CloudAuthError(`Google sign-in failed: ${err}`);
  const token = h.get('access_token');
  if (!token) throw new CloudAuthError('Google sign-in returned no access token');
  return { token, expiresIn: Number(h.get('expires_in') ?? 3600) };
}

async function googleToken(cfg: CloudConfig, interactive: boolean, loginHint?: string): Promise<{ token: string; expiresIn: number }> {
  const redirect = chrome.identity.getRedirectURL();
  const url = await chrome.identity.launchWebAuthFlow({ url: authUrl(cfg, redirect, interactive, loginHint), interactive });
  if (!url) throw new CloudAuthError('Google sign-in was cancelled');
  return parseRedirect(url);
}

async function firebaseSignIn(cfg: CloudConfig, googleAccessToken: string, f: Fetch) {
  const r = await f(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${encodeURIComponent(googleAccessToken)}&providerId=google.com`,
      requestUri: chrome.identity.getRedirectURL(),
      returnSecureToken: true,
      returnIdpCredential: true,
    }),
  });
  const j = (await r.json()) as { localId?: string; email?: string; idToken?: string; refreshToken?: string; expiresIn?: string; error?: { message: string } };
  if (!r.ok || !j.idToken) throw new CloudAuthError(`Firebase sign-in failed: ${j.error?.message ?? r.status}`);
  return j as Required<Pick<typeof j, 'localId' | 'email' | 'idToken' | 'refreshToken' | 'expiresIn'>>;
}

/** Interactive "Login with Google". */
export async function signIn(f: Fetch = fetch): Promise<CloudSession> {
  const cfg = await getCloudConfig();
  if (!cfg) throw new CloudAuthError('Fill in the Firebase settings first');
  const g = await googleToken(cfg, true);
  const fb = await firebaseSignIn(cfg, g.token, f);
  const now = Date.now();
  const s: CloudSession = {
    uid: fb.localId, email: fb.email, idToken: fb.idToken, refreshToken: fb.refreshToken,
    idExpiresAt: now + Number(fb.expiresIn) * 1000, googleToken: g.token, googleExpiresAt: now + g.expiresIn * 1000,
  };
  await setSession(s);
  return s;
}

export async function signOut(): Promise<void> {
  const s = await getSession();
  if (s?.googleToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.googleToken)}`, { method: 'POST' }).catch(() => undefined);
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

/** Valid Google access token for Drive; renewed silently (no popup) when possible. */
export async function driveToken(now = Date.now()): Promise<string> {
  const s = await getSession();
  const cfg = await getCloudConfig();
  if (!s || !cfg) throw new CloudAuthError('Not signed in to the cloud');
  if (s.googleExpiresAt - now > 5 * 60_000) return s.googleToken;
  const g = await googleToken(cfg, false, s.email).catch(() => {
    throw new CloudAuthError('Google Drive access expired — open the Cloud page and sign in again');
  });
  await setSession({ ...s, googleToken: g.token, googleExpiresAt: now + g.expiresIn * 1000 });
  return g.token;
}
