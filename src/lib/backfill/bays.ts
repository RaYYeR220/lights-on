import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { nightDate, shiftStartFor, nightNumber } from '@/lib/shift/night';
import { nightsEndingAt } from '@/lib/views/tower';

/**
 * One-off bay reassignment before launch (scripts/reassign-bays.ts): bay 1 is the top-left window of the tower, so the
 * floors above the fold should hold the most active projects. Bays are otherwise stable (assigned once at creation,
 * migration 0009 backfilled them by source then name); this reorders them once and is idempotent.
 */
export const ACTIVITY_NIGHTS = 90;
/** Cohort order, as in migration 0009: Vibestarter raises, Vibeathon 01 finalists, Base apps, then the rest. */
const COHORT_RANK: Record<string, number> = { vibestarter: 1, vibeathon01: 2, base: 3 };

export interface BayRow {
  id: number; slug: string; name: string; source: string; hidden: boolean; bay: number | null;
  shipped: number; building: number;
}
export interface BayMove { id: number; slug: string; from: number | null; to: number; score: number; shipped: number; building: number }

/** shipped nights x3 + building nights, over the last ACTIVITY_NIGHTS nights. */
export const activityScore = (r: Pick<BayRow, 'shipped' | 'building'>) => 3 * r.shipped + r.building;
const listed = (r: BayRow) => !r.hidden && r.source !== 'community';

/**
 * Listed projects first (the tower shows only those): activity descending, then cohort, then name (case-insensitive),
 * then id. Unlisted ones (hidden, community watches) follow in their current bay order. Returns every project's new bay.
 */
export function planBays(rows: BayRow[]): BayMove[] {
  const shown = rows.filter(listed).sort((a, b) =>
    activityScore(b) - activityScore(a)
    || (COHORT_RANK[a.source] ?? 9) - (COHORT_RANK[b.source] ?? 9)
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    || a.id - b.id);
  const rest = rows.filter((r) => !listed(r)).sort((a, b) =>
    (a.bay ?? Number.MAX_SAFE_INTEGER) - (b.bay ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  return [...shown, ...rest].map((r, i) => ({
    id: r.id, slug: r.slug, from: r.bay, to: i + 1, score: activityScore(r), shipped: r.shipped, building: r.building,
  }));
}

/** Every project with its shipped/building nights in the ACTIVITY_NIGHTS ending at the latest shift (observed row wins). */
export async function loadBayRows(db: Db, now: Date = new Date()): Promise<BayRow[]> {
  const last = nightNumber(shiftStartFor(now));
  const from = nightDate(nightsEndingAt(last, ACTIVITY_NIGHTS)[0]);
  const to = nightDate(last);
  const res = await db.execute(sql`
    WITH picked AS (
      SELECT DISTINCT ON (project_id, night) project_id, night, status
      FROM nights WHERE night >= ${from}::date AND night <= ${to}::date
      ORDER BY project_id, night, observed DESC
    ), act AS (
      SELECT project_id,
        count(*) FILTER (WHERE status = 'shipped')::int AS shipped,
        count(*) FILTER (WHERE status = 'building')::int AS building
      FROM picked GROUP BY project_id
    )
    SELECT p.id, p.slug, p.name, p.source, p.hidden, p.bay, COALESCE(a.shipped, 0) AS shipped, COALESCE(a.building, 0) AS building
    FROM projects p LEFT JOIN act a ON a.project_id = p.id
    ORDER BY p.id`);
  return (res as unknown as { rows: BayRow[] }).rows.map((r) => ({
    ...r, id: Number(r.id), bay: r.bay === null ? null : Number(r.bay), shipped: Number(r.shipped), building: Number(r.building),
  }));
}

/**
 * Write the planned bays. `bay` is UNIQUE (not deferrable) and Neon HTTP has no transactions, so two statements: park
 * every moving row on a negative bay, then set the final ones. A crash between them leaves negative bays that a re-run
 * fixes (the plan depends only on activity, never on the current bays of listed projects).
 */
export async function applyBays(db: Db, moves: BayMove[]): Promise<number> {
  const changed = moves.filter((m) => m.from !== m.to);
  if (changed.length === 0) return 0;
  const values = (sign: 1 | -1) => sql.join(changed.map((m) => sql`(${m.id}::int, ${sign * m.to}::int)`), sql`, `);
  await db.execute(sql`UPDATE projects SET bay = v.bay FROM (VALUES ${values(-1)}) AS v(id, bay) WHERE projects.id = v.id`);
  await db.execute(sql`UPDATE projects SET bay = v.bay FROM (VALUES ${values(1)}) AS v(id, bay) WHERE projects.id = v.id`);
  return changed.length;
}

/** Human-readable diff of a plan (only the bays that change). */
export function describeMoves(moves: BayMove[]): string[] {
  return moves
    .filter((m) => m.from !== m.to)
    .map((m) => `bay ${String(m.from ?? '-').padStart(3)} -> ${String(m.to).padStart(3)}  ${m.slug}  (score ${m.score}: ${m.shipped} shipped, ${m.building} building)`);
}
