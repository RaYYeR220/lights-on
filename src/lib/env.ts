import { z } from 'zod';

// Empty strings (e.g. `KEY=` in .env) count as unset.
const optStr = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);

const schema = z.object({
  DATABASE_URL: z.string().min(1), // not z.url(): tests use pglite://memory
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_CHAIN_ID: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(8453),
  ),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: optStr,
  VENICE_API_KEY: optStr,
  WATCHER_PRIVATE_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x + 64 hex chars').optional(),
  ),
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_WEBHOOK_SECRET: optStr,
  VAPID_PRIVATE_KEY: optStr,
  INTERNAL_RUN_TOKEN: optStr,
  CRON_SECRET: optStr,
  GITHUB_READ_TOKEN: optStr,
});

export type Env = z.infer<typeof schema>;
export type Feature = 'telegram' | 'webpush' | 'attest' | 'github' | 'ai';

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

let cached: Env | undefined;

/** Lazily parsed process.env; first property access validates, so importing never throws. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop) {
    cached ??= parseEnv();
    return cached[prop as keyof Env];
  },
});

export function hasFeature(
  name: Feature,
  source: Record<string, string | undefined> = process.env,
): boolean {
  const set = (k: string) => !!source[k];
  switch (name) {
    case 'telegram':
      return set('TELEGRAM_BOT_TOKEN');
    case 'webpush':
      return set('VAPID_PRIVATE_KEY') && set('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
    case 'attest':
      return set('WATCHER_PRIVATE_KEY');
    case 'github':
      return set('GITHUB_READ_TOKEN');
    case 'ai':
      return set('VENICE_API_KEY');
  }
}
