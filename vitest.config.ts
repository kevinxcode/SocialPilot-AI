import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { globals: true, environment: 'node', environmentMatchGlobs: [['tests/**/*.test.tsx', 'jsdom'], ['tests/rpa/**', 'jsdom']], setupFiles: ['tests/setup.ts'], include: ['tests/**/*.test.{ts,tsx}'] },
});
