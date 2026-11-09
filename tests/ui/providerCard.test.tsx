import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderCard } from '@/pages/ProviderCard';
import type { TestResult } from '@/services/ai/types';

const cfg = { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 60_000, apiKey: 'sk-or-secret' };

test('test button shows testing state then result', async () => {
  let resolve!: (r: TestResult) => void;
  const onTest = vi.fn(() => new Promise<TestResult>((r) => (resolve = r)));
  render(<ProviderCard id="openrouter" label="OpenRouter" cfg={cfg} models={[]} onChange={() => {}} onTest={onTest} onRefresh={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
  expect(await screen.findByRole('button', { name: /testing/i })).toHaveProperty('disabled', true);
  resolve({ ok: false, message: 'HTTP 401 (check API key)', latencyMs: 12 });
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Failed — HTTP 401/));
  expect(screen.getByRole('button', { name: /test connection/i })).toHaveProperty("disabled", false);
});

test('API key is in a password field', () => {
  render(<ProviderCard id="openrouter" label="OpenRouter" cfg={cfg} models={[]} onChange={() => {}} onTest={async () => ({ ok: true, message: '', latencyMs: 0 })} onRefresh={async () => {}} />);
  const input = screen.getByPlaceholderText('sk-or-…') as HTMLInputElement;
  expect(input.type).toBe('password');
});
