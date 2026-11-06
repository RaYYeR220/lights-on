import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    testTimeout: 20_000, // pglite + migrations is slow when the whole suite runs in parallel
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/fork/**', 'node_modules/**'],
    coverage: { provider: 'v8' },
  },
});
