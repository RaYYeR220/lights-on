import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { insertNight, upsertProject } from '@/lib/db/queries';
import { projects } from '@/lib/db/schema';
import { applyBays, describeMoves, loadBayRows, planBays, type BayRow } from '@/lib/backfill/bays';
import { getTowerData } from '@/lib/views/tower';
import { asc } from 'drizzle-orm';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });
const NOW = new Date('2026-11-06T12:00:00Z');

const row = (o: Partial<BayRow> & Pick<BayRow, 'id' | 'slug'>): BayRow => ({
  name: o.slug, source: 'base', hidden: false, bay: o.id, shipped: 0, building: 0, ...o,
});

describe('planBays', () => {
  it('activity (shipped x3 + building) desc, then cohort, then name; unlisted after, in their bay order', () => {
    const plan = planBays([
      row({ id: 1, slug: 'quiet-base', name: 'Alpha' }),
      row({ id: 2, slug: 'busy', building: 10 }), // 10
      row({ id: 3, slug: 'shipper', shipped: 4 }), // 12
      row({ id: 4, slug: 'tie-vibe', source: 'vibestarter', building: 3 }), // 3
      row({ id: 5, slug: 'tie-base', source: 'base', shipped: 1 }), // 3
      row({ id: 6, slug: 'watch', source: 'community', shipped: 50, bay: 2 }),
      row({ id: 7, slug: 'hidden', hidden: true, shipped: 50, bay: 1 }),
      row({ id: 8, slug: 'quiet-v01', name: 'zeta', source: 'vibeathon01' }),
    ]);
    expect(plan.map((m) => m.slug)).toEqual(['shipper', 'busy', 'tie-vibe', 'tie-base', 'quiet-v01', 'quiet-base', 'hidden', 'watch']);
    expect(plan.map((m) => m.to)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan[0]).toMatchObject({ score: 12, from: 3 });
  });
});

describe('reassign bays on the database', () => {
  it('dry run changes nothing; apply writes a permutation (unique bays), a second run changes nothing; the tower follows', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'A', source: 'vibestarter' }); // bay 1, quiet
    const b = await upsertProject(db, { slug: 'b', name: 'B', source: 'base' }); // bay 2, building nights
    const c = await upsertProject(db, { slug: 'c', name: 'C', source: 'base' }); // bay 3, shipped nights
    await upsertProject(db, { slug: 'w', name: 'W', source: 'community', hidden: true }); // bay 4, unlisted
    for (const d of ['2026-11-03', '2026-11-04', '2026-11-05']) await insertNight(db, { projectId: b.id, night: d, status: 'building', observed: true });
    await insertNight(db, { projectId: c.id, night: '2026-11-04', status: 'shipped', observed: false });
    await insertNight(db, { projectId: c.id, night: '2026-11-03', status: 'shipped', observed: true });
    await insertNight(db, { projectId: c.id, night: '2026-11-05', status: 'shipped', observed: false });
    // the observed row wins over a reconstructed one for the same night
    await insertNight(db, { projectId: c.id, night: '2026-11-05', status: 'quiet', observed: true });
    await insertNight(db, { projectId: a.id, night: '2026-06-01', status: 'shipped', observed: true }); // outside 90 nights

    const plan = planBays(await loadBayRows(db, NOW));
    expect(plan.map((m) => [m.slug, m.score])).toEqual([['c', 6], ['b', 3], ['a', 0], ['w', 0]]);
    // dry run: nothing written
    expect(describeMoves(plan)).toEqual([expect.stringMatching(/bay +3 -> +1  c/), expect.stringMatching(/bay +1 -> +3  a/)]); // b stays on 2
    expect((await db.select({ bay: projects.bay }).from(projects).orderBy(asc(projects.id))).map((r) => r.bay)).toEqual([1, 2, 3, 4]);

    expect(await applyBays(db, plan)).toBe(2);
    const bays = await db.select({ slug: projects.slug, bay: projects.bay }).from(projects).orderBy(asc(projects.bay));
    expect(bays).toEqual([{ slug: 'c', bay: 1 }, { slug: 'b', bay: 2 }, { slug: 'a', bay: 3 }, { slug: 'w', bay: 4 }]);
    expect(describeMoves(planBays(await loadBayRows(db, NOW)))).toEqual([]);
    expect(await applyBays(db, planBays(await loadBayRows(db, NOW)))).toBe(0);
    expect((await getTowerData(db, { now: NOW })).projects.map((p) => p.slug)).toEqual(['c', 'b', 'a']);
    // a new project still gets max+1
    expect((await upsertProject(db, { slug: 'n', name: 'N', source: 'base' })).bay).toBe(5);
  });
});
