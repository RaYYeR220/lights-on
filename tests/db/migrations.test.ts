import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';

const dir = path.resolve(__dirname, '../../drizzle');
const run = async (pg: PGlite, file: string) => {
  for (const stmt of fs.readFileSync(path.join(dir, file), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await pg.exec(stmt);
  }
};

describe('migration 0011: shifts.attest_tx becomes a tx list', () => {
  it('splits legacy comma-joined values into one entry per tx', async () => {
    const pg = new PGlite();
    const target = '0011_shift_attest_txs.sql';
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(all).toContain(target);
    for (const f of all.filter((x) => x < target)) await run(pg, f);
    const a = `0x${'a'.repeat(64)}`;
    const b = `0x${'b'.repeat(64)}`;
    await pg.exec(`insert into shifts (kind, night, attest_tx) values
      ('nightly', '2026-11-04', '${a},${b}'), ('nightly', '2026-11-05', '${a}'), ('nightly', '2026-11-06', null),
      ('live', '2026-11-06', '')`);
    await run(pg, target);
    const r = await pg.query<{ night: string; attest_tx: string[] | null }>(`select night::text, attest_tx from shifts order by id`);
    expect(r.rows.map((x) => x.attest_tx)).toEqual([[a, b], [a], null, null]);
  });
});
