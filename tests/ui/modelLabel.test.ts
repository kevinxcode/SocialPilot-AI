import { modelOptionLabel } from '@/pages/ProviderCard';

test('does not repeat (free) when the model name already contains it', () => {
  expect(modelOptionLabel({ providerId: 'openrouter', id: 'g/gemma:free', name: 'Google: Gemma 4 26B A4B (free)', isFree: true, vision: true })).toBe('Google: Gemma 4 26B A4B (free) 👁');
  expect(modelOptionLabel({ providerId: 'openrouter', id: 'a/b', name: 'A B', isFree: false, vision: false })).toBe('A B (paid)');
});
