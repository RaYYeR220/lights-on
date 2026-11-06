import { z } from 'zod';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Environment check, run once at server start (src/instrumentation.ts). Every variable is listed in .env.example.
 * Code keeps reading process.env directly (a missing optional variable degrades its feature); this module only decides
 * whether the deployment is fit to serve: on the production deployment (VERCEL_ENV=production, or
 * LIGHTS_ON_STRICT_ENV=1) any error stops the server, elsewhere errors and warnings are logged. Messages carry names,
 * never values.
 */

// Empty strings (e.g. `KEY=` in .env) count as unset.
const blank = (v: unknown) => (v === '' ? undefined : v);

/**
 * The same leniency as the code that reads each variable, so the check never rejects a value the app accepts:
 * a key without `0x` (getWallet adds it), a bot name with `@` (telegramLink strips it), empty entries in the attester
 * list (Verify drops them).
 */
export function normalizeWatcherKey(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return undefined;
  return /^[0-9a-fA-F]{64}$/.test(t) ? `0x${t}` : t;
}
export function normalizeBot(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/^@/, '').trim();
  return t || undefined;
}
export function normalizeAddressList(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const xs = v.split(',').map((a) => a.trim()).filter(Boolean);
  return xs.length ? xs.join(',') : undefined;
}
const optStr = z.preprocess(blank, z.string().min(1).optional());
const httpUrl = z.preprocess(blank, z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL').optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1), // not z.url(): tests use pglite://memory
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: optStr,
  VENICE_API_KEY: optStr,
  WATCHER_PRIVATE_KEY: z.preprocess(normalizeWatcherKey, z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 64 hex chars (0x optional)').optional()),
  WATCHER_AGENT_ID: z.preprocess(blank, z.string().regex(/^\d{1,30}$/, 'must be a decimal agent id').optional()),
  NEXT_PUBLIC_WATCHER_ADDRESS: z.preprocess(
    normalizeAddressList,
    z.string().refine((v) => v.split(',').every((a) => isAddress(a, { strict: false })), 'must be comma-separated 0x addresses').optional(),
  ),
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_WEBHOOK_SECRET: optStr,
  NEXT_PUBLIC_TELEGRAM_BOT: z.preprocess(normalizeBot, z.string().regex(/^[A-Za-z0-9_]{3,64}$/, 'must be a bot username').optional()),
  VAPID_PRIVATE_KEY: optStr,
  INTERNAL_RUN_TOKEN: optStr,
  CRON_SECRET: optStr,
  GITHUB_READ_TOKEN: optStr,
  INTERNAL_BASE_URL: httpUrl,
  BASE_RPC_URL: httpUrl,
  ETH_RPC_URL: httpUrl,
  NEXT_PUBLIC_BASE_RPC_URL: httpUrl,
});

export type Env = z.infer<typeof schema>;
export type Feature = 'telegram' | 'webpush' | 'attest' | 'github' | 'ai';
type Source = Record<string, string | undefined>;

/** Throws a ZodError on a missing DATABASE_URL / NEXT_PUBLIC_SITE_URL or a malformed value. */
export function parseEnv(source: Source = process.env): Env {
  return schema.parse(source);
}

/** Always required (parseEnv rejects without them). */
const REQUIRED = new Set(['DATABASE_URL', 'NEXT_PUBLIC_SITE_URL']);
/** Server variables the production deployment cannot run without (besides REQUIRED). */
const REQUIRED_IN_PROD = ['INTERNAL_RUN_TOKEN', 'CRON_SECRET'] as const;

export interface EnvReport { errors: string[]; warnings: string[] }

/**
 * Missing or malformed REQUIRED variables are errors; a malformed OPTIONAL one is a warning (its feature reads it with
 * its own fallback and degrades, the site still serves). Never any value, only names.
 */
export function checkEnv(source: Source = process.env, opts: { production?: boolean } = {}): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = schema.safeParse(source);
  if (!r.success) {
    for (const i of r.error.issues) {
      const name = String(i.path[0] ?? '?');
      const msg = source[name] ? `${name}: ${i.message}` : `${name} is not set`;
      (REQUIRED.has(name) ? errors : warnings).push(REQUIRED.has(name) ? msg : `${msg} (its feature is off or degraded)`);
    }
  }
  const set = (k: string) => !!source[k];
  if (opts.production) {
    for (const k of REQUIRED_IN_PROD) if (!set(k)) errors.push(`${k} is not set`);
    const site = source.NEXT_PUBLIC_SITE_URL ?? '';
    if (site && !/^https:\/\//.test(site)) errors.push('NEXT_PUBLIC_SITE_URL: must be https in production');
  }
  if (!set('WATCHER_PRIVATE_KEY')) warnings.push('WATCHER_PRIVATE_KEY is not set: nights are not attested');
  if (!set('WATCHER_AGENT_ID') || source.WATCHER_AGENT_ID === '0') warnings.push('WATCHER_AGENT_ID is not set: nights are not attested');
  const key = normalizeWatcherKey(source.WATCHER_PRIVATE_KEY);
  if (typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    const me = privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
    const allow = String(normalizeAddressList(source.NEXT_PUBLIC_WATCHER_ADDRESS) ?? '').split(',').map((a) => a.toLowerCase());
    if (!allow.includes(me)) warnings.push('NEXT_PUBLIC_WATCHER_ADDRESS does not include the watcher wallet: in-browser Verify will fail');
  }
  if (!set('INTERNAL_BASE_URL') && !set('NEXT_PUBLIC_SITE_URL')) warnings.push('INTERNAL_BASE_URL is not set: shift runs go to the request origin');
  if (!set('VENICE_API_KEY')) warnings.push('VENICE_API_KEY is not set: no AI explanations');
  if (set('TELEGRAM_BOT_TOKEN') !== set('TELEGRAM_WEBHOOK_SECRET')) warnings.push('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set together');
  if (set('VAPID_PRIVATE_KEY') !== set('NEXT_PUBLIC_VAPID_PUBLIC_KEY')) warnings.push('VAPID_PRIVATE_KEY and NEXT_PUBLIC_VAPID_PUBLIC_KEY must be set together');
  if (!set('GITHUB_READ_TOKEN')) warnings.push('GITHUB_READ_TOKEN is not set: repos are read from the public Atom feed');
  return { errors, warnings };
}

/** The production deployment (or an explicit opt-in) refuses to start with env errors. */
export function strictEnv(source: Source = process.env): boolean {
  return source.VERCEL_ENV === 'production' || source.LIGHTS_ON_STRICT_ENV === '1';
}

/** Server-start check: logs warnings; on a strict deployment throws on any error, otherwise logs them. */
export function assertEnv(source: Source = process.env, log: Pick<Console, 'warn' | 'error'> = console): EnvReport {
  const strict = strictEnv(source);
  const report = checkEnv(source, { production: strict });
  for (const w of report.warnings) log.warn(`env: ${w}`);
  if (report.errors.length) {
    const msg = `env: ${report.errors.join('; ')}`;
    if (strict) throw new Error(msg);
    log.error(msg);
  }
  return report;
}

export function hasFeature(name: Feature, source: Source = process.env): boolean {
  const set = (k: string) => !!source[k];
  switch (name) {
    case 'telegram':
      return set('TELEGRAM_BOT_TOKEN');
    case 'webpush':
      return set('VAPID_PRIVATE_KEY') && set('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
    case 'attest':
      return set('WATCHER_PRIVATE_KEY') && set('WATCHER_AGENT_ID');
    case 'github':
      return set('GITHUB_READ_TOKEN');
    case 'ai':
      return set('VENICE_API_KEY');
  }
}
