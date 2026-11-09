/**
 * Cloud (Firebase + Google Drive) configuration and session, kept in chrome.storage.local of THIS device only.
 * Nothing here is hardcoded: the user pastes the values of their own Firebase project in the Cloud page.
 */
export interface CloudConfig {
  /** Firebase Web API key (public by design; access is protected by Firestore security rules) */
  apiKey: string;
  projectId: string;
  /** Google OAuth client id of type "Web application", redirect URI = chrome.identity.getRedirectURL() */
  clientId: string;
}

export interface CloudSession {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  /** ms epoch when idToken expires */
  idExpiresAt: number;
  /** Google access token (Drive) and its expiry */
  googleToken: string;
  googleExpiresAt: number;
}

const CONFIG_KEY = 'cloudConfig';
const SESSION_KEY = 'cloudSession';
const DEVICE_KEY = 'cloudDeviceId';

/** Config baked in at build time from .env.local (VITE_FIREBASE_*), so users only see "Login with Google". */
export function builtInConfig(env: Record<string, string | undefined> = import.meta.env): CloudConfig | null {
  const c = { apiKey: env.VITE_FIREBASE_API_KEY ?? '', projectId: env.VITE_FIREBASE_PROJECT_ID ?? '', clientId: env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? '' };
  return c.apiKey && c.projectId && c.clientId ? c : null;
}

/** Values entered by hand on this device win; otherwise the built-in project is used. */
export async function getCloudConfig(): Promise<CloudConfig | null> {
  const c = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as CloudConfig | undefined;
  return c?.apiKey && c.projectId && c.clientId ? c : builtInConfig();
}

export async function setCloudConfig(c: CloudConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: { apiKey: c.apiKey.trim(), projectId: c.projectId.trim(), clientId: c.clientId.trim() } });
}

export async function getSession(): Promise<CloudSession | null> {
  return ((await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] as CloudSession | undefined) ?? null;
}

export async function setSession(s: CloudSession | null): Promise<void> {
  if (s) await chrome.storage.local.set({ [SESSION_KEY]: s });
  else await chrome.storage.local.remove(SESSION_KEY);
}

/** Stable random id of this browser profile (used by the autopilot lock). */
export async function deviceId(): Promise<string> {
  const cur = (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY] as string | undefined;
  if (cur) return cur;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}
