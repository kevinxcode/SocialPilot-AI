import { buildOllamaOriginRule, OLLAMA_RULE_ID } from '@/background/ollamaOrigin';

test('rule strips Origin only for this extension’s requests to the configured Ollama host', () => {
  const r = buildOllamaOriginRule('http://localhost:11434', 'abcdefghijklmnopabcdefghijklmnop');
  expect(r).toEqual({
    id: OLLAMA_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: '|http://localhost:11434/',
      initiatorDomains: ['abcdefghijklmnopabcdefghijklmnop'],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  });
});

test('custom LAN host with trailing slash', () => {
  expect(buildOllamaOriginRule('http://192.168.1.20:11434/', 'x')!.condition.urlFilter).toBe('|http://192.168.1.20:11434/');
});

test('invalid host → null', () => {
  expect(buildOllamaOriginRule('not a url', 'x')).toBeNull();
});

test('OpenRouter or Facebook are never matched', () => {
  const r = buildOllamaOriginRule('http://localhost:11434', 'x')!;
  expect(r.condition.urlFilter).not.toMatch(/openrouter|facebook|threads/);
});
