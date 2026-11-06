import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import type { Db } from '@/lib/db';

/**
 * One migrated in-memory pglite per test file (vitest isolates modules per file), wiped before every use.
 * Booting PGlite + running every migration for each test made the full suite slow enough under parallel load to hit
 * hook timeouts; a TRUNCATE ... RESTART IDENTITY gives each test the same empty database in milliseconds.
 */
let shared: Promise<{ pg: PGlite; db: Db; wipe: string }> | undefined;

async function boot(): Promise<{ pg: PGlite; db: Db; wipe: string }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  const { rows } = await pg.query<{ t: string }>(`SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'`);
  const wipe = rows.length ? `TRUNCATE ${rows.map((r) => r.t).join(', ')} RESTART IDENTITY CASCADE` : '';
  return { pg, db: db as unknown as Db, wipe };
}

/** An empty, fully migrated database (fresh ids). The handle is shared within the file: call once per test. */
export async function makeTestDb(): Promise<Db> {
  shared ??= boot();
  shared.catch(() => { shared = undefined; });
  const { pg, db, wipe } = await shared;
  if (wipe) await pg.exec(wipe);
  return db;
}
