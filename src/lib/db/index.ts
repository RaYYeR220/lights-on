import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Common drizzle Postgres database type shared by neon-http (prod) and pglite (tests):
 * both extend PgDatabase; the query-result HKT differs, so it is left open (`any`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

let cached: { url: string; p: Promise<Db> } | undefined;

async function build(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const [{ PGlite }, { drizzle }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('drizzle-orm/pglite'),
    ]);
    const dir = url.slice('pglite://'.length);
    return drizzle(dir && dir !== 'memory' ? new PGlite(dir) : new PGlite(), { schema }) as unknown as Db;
  }
  if (!url) throw new Error('DATABASE_URL is not set');
  const [{ neon }, { drizzle }] = await Promise.all([
    import('@neondatabase/serverless'),
    import('drizzle-orm/neon-http'),
  ]);
  return drizzle(neon(url), { schema }) as unknown as Db;
}

/** Neon HTTP in prod; pglite when the URL starts with `pglite://` (`pglite://memory` = in-memory). */
export function getDb(url: string = process.env.DATABASE_URL ?? ''): Promise<Db> {
  if (cached && cached.url === url) return cached.p;
  const entry = { url, p: build(url) };
  cached = entry;
  // On failure drop the cache so the next call retries.
  entry.p.catch(() => { if (cached === entry) cached = undefined; });
  return entry.p;
}
