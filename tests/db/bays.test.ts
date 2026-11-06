import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { makeTestDb } from '../helpers/db';
import { upsertProject } from '@/lib/db/queries';

describe('stable bays', () => {
  it('new projects get max+1; updates never change a bay', async () => {
    const db = await makeTestDb();
    const a = await upsertProject(db, { slug: 'a', name: 'A', source: 'community' });
    const b = await upsertProject(db, { slug: 'b', name: 'B', source: 'community' });
    expect([a.bay, b.bay]).toEqual([1, 2]);
    const a2 = await upsertProject(db, { slug: 'a', name: 'A2', source: 'base', bay: 99 });
    expect(a2.bay).toBe(1);
    expect(a2.name).toBe('A2');
    const c = await upsertProject(db, { slug: 'c', name: 'C', source: 'community' });
    expect(c.bay).toBe(3);
  });

  it('migration 0009 backfills in source order, then case-insensitive name', async () => {
    const pg = new PGlite();
    const dir = path.resolve(__dirname, '../../drizzle');
    // apply everything except 0009 by hand-running the files in order, seed, then run 0009
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const last = files.pop()!;
    expect(last).toBe('0009_project_bays.sql');
    for (const f of files) {
      for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await pg.exec(stmt);
      }
    }
    await pg.exec(`insert into projects (slug,name,source) values
      ('c1','zeta','community'),('v1','Beta','vibestarter'),('v2','alpha','vibestarter'),
      ('o1','Omega','vibeathon01'),('b1','Base One','base')`);
    for (const stmt of fs.readFileSync(path.join(dir, last), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
    const r = await pg.query<{ slug: string; bay: number }>('select slug, bay from projects order by bay');
    expect(r.rows.map((x) => x.slug)).toEqual(['v2', 'v1', 'o1', 'b1', 'c1']);
    expect(r.rows.map((x) => x.bay)).toEqual([1, 2, 3, 4, 5]);
  });
});
