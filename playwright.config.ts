import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests for the pages. By default they start `next dev` on PORT (3217); set E2E_SERVER=start to run against a
 * production build (`pnpm build` first), or BASE_URL to test a server that is already running (local or deployed).
 */
const PORT = Number(process.env.PORT ?? 3217);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const command = process.env.E2E_SERVER === "start" ? `pnpm exec next start -p ${PORT}` : `pnpm exec next dev -p ${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command, url: BASE_URL, reuseExistingServer: !process.env.CI, timeout: 180_000 },
});
