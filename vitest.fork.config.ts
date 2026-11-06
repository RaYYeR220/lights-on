import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/fork/**/*.fork.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
