/**
 * End-to-end encryption for secrets that are synced (AI API keys): AES-GCM 256 with a key derived from the user's
 * passphrase (PBKDF2-SHA256, 310 000 iterations, random salt). The passphrase never leaves the device; the cloud only
 * ever sees ciphertext. Without the passphrase the keys cannot be recovered.
 */
const ITER = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(value: unknown, passphrase: string): Promise<Sealed> {
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt), enc.encode(JSON.stringify(value)));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) };
}

export class WrongPassphraseError extends Error {
  name = 'WrongPassphraseError';
}

export async function open<T>(sealed: Sealed, passphrase: string): Promise<T> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) as BufferSource }, await keyFrom(passphrase, unb64(sealed.salt)), unb64(sealed.data) as BufferSource);
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    throw new WrongPassphraseError('Wrong passphrase — the synced API keys could not be decrypted');
  }
}

const PASS_KEY = 'cloudPassphrase';
/** The passphrase is remembered on this device only, so autopilot can run unattended. */
export async function getPassphrase(): Promise<string | null> {
  return ((await chrome.storage.local.get(PASS_KEY))[PASS_KEY] as string | undefined) ?? null;
}
export async function setPassphrase(p: string | null): Promise<void> {
  if (p !== null && p.length < 8) throw new Error('Passphrase must be at least 8 characters');
  if (p) await chrome.storage.local.set({ [PASS_KEY]: p });
  else await chrome.storage.local.remove(PASS_KEY);
}
