/**
 * Runs once when a server instance starts. On the production deployment a missing required variable or a malformed
 * value stops the server here, loudly, instead of degrading at the first cron (see src/lib/env.ts and .env.example).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnv } = await import('./lib/env');
  assertEnv();
}
