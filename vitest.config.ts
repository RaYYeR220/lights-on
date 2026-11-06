import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    testTimeout: 30_000, // pglite + migrations is slow when the whole suite runs in parallel
    hookTimeout: 60_000, // the first makeTestDb() of a file boots PGlite and migrates (tests/helpers/db.ts)
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/fork/**', 'node_modules/**'],
    coverage: { provider: 'v8' },
  },
});
