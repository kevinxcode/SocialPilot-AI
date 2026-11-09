import { render, screen } from '@testing-library/react';
import { LoginGate } from '@/components/LoginGate';
import { ToastProvider } from '@/components/ui';

const CFG = { apiKey: 'AIzaX', projectId: 'p', clientId: 'c.apps.googleusercontent.com' };
const show = (mode: 'dashboard' | 'popup' = 'dashboard') =>
  render(
    <ToastProvider>
      <LoginGate mode={mode}>
        <div>APP CONTENT</div>
      </LoginGate>
    </ToastProvider>,
  );

beforeEach(async () => {
  await chrome.storage.local.clear();
});
afterEach(() => vi.unstubAllEnvs());

test('built-in project (from the build) → only the Login with Google button, no setup fields', async () => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'AIzaX');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'p');
  vi.stubEnv('VITE_GOOGLE_OAUTH_CLIENT_ID', 'c.apps.googleusercontent.com');
  show();
  expect(await screen.findByRole('button', { name: /login with google/i })).toBeTruthy();
  expect(screen.queryByText(/web api key/i)).toBeNull();
});

test('not signed in → the app is hidden behind "Login with Google"', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG });
  show();
  expect(await screen.findByRole('button', { name: /login with google/i })).toBeTruthy();
  expect(screen.queryByText('APP CONTENT')).toBeNull();
  expect(screen.queryByText(/continue offline/i)).toBeNull(); // once the cloud is set up, login is mandatory
});

test('signed in → the app is shown', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG, cloudSession: { uid: 'u' } });
  show();
  expect(await screen.findByText('APP CONTENT')).toBeTruthy();
});

test('cloud not set up yet → setup fields + a temporary offline way in', async () => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', '');
  show();
  expect(await screen.findByText(/continue offline/i)).toBeTruthy();
  expect((screen.getByRole('button', { name: /login with google/i }) as HTMLButtonElement).disabled).toBe(true);
  await chrome.storage.local.set({ cloudGateSkipped: true });
  show();
  expect(await screen.findByText('APP CONTENT')).toBeTruthy();
});

test('popup: asks to open the dashboard to sign in', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG });
  show('popup');
  expect(await screen.findByRole('button', { name: /open to sign in/i })).toBeTruthy();
});
