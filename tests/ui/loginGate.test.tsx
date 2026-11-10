import { render, screen } from '@testing-library/react';
import { LoginGate } from '@/components/LoginGate';
import { ToastProvider } from '@/components/ui';

const CFG = { apiKey: 'AIzaX', projectId: 'p' };
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

test('built-in project (from the build) → only email + password, no setup fields', async () => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'AIzaX');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'p');
  show();
  expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeTruthy();
  expect(screen.getByText('Email')).toBeTruthy();
  expect(screen.getByText('Password')).toBeTruthy();
  expect(screen.getByText(/forgot password/i)).toBeTruthy();
  expect(screen.queryByText(/web api key/i)).toBeNull();
});

test('not signed in → the app is hidden behind the sign-in form', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG });
  show();
  expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeTruthy();
  expect(screen.queryByText('APP CONTENT')).toBeNull();
  expect(screen.getByText(/continue without an account/i)).toBeTruthy(); // login is optional
});

test('signed in → the app is shown', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG, cloudSession: { uid: 'u' } });
  show();
  expect(await screen.findByText('APP CONTENT')).toBeTruthy();
});

test('cloud not set up yet → setup fields + a temporary offline way in', async () => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', '');
  show();
  expect(await screen.findByText(/continue without an account/i)).toBeTruthy();
  expect((screen.getByRole('button', { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(true);
  await chrome.storage.local.set({ cloudGateSkipped: true });
  show();
  expect(await screen.findByText('APP CONTENT')).toBeTruthy();
});

test('popup: asks to open the dashboard to sign in', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG });
  show('popup');
  expect(await screen.findByRole('button', { name: /open to sign in/i })).toBeTruthy();
});

test('continue without an account → the app opens and stays open (also when the cloud is set up)', async () => {
  await chrome.storage.local.set({ cloudConfig: CFG, cloudGateSkipped: true });
  show();
  expect(await screen.findByText('APP CONTENT')).toBeTruthy();
});
