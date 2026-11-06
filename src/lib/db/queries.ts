import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from './index';
import {
  projects, nights, liveRuns, evidence, snapshots, budget, shifts,
  type ProjectRow, type NewProject, type NightRow, type NewNight, type LiveRunRow, type NewLiveRun, type SnapshotRow,
  type ShiftRow,
} from './schema';
import type { EvidenceBundle } from '@/lib/types';

export class DuplicateNight extends Error {
  constructor(projectId: number, night: string, observed: boolean) {
    super(`night already recorded: project ${projectId}, ${night}, observed=${observed}`);
    this.name = 'DuplicateNight';
  }
}

export async function upsertProject(db: Db, p: NewProject): Promise<ProjectRow> {
  const { slug, ...rest } = p;
  const [row] = await db
    .insert(projects)
    .values(p)
    .onConflictDoUpdate({ target: projects.slug, set: rest })
    .returning();
  if (!row) throw new Error(`upsertProject failed for ${slug}`);
  return row;
}

export async function getProjectBySlug(db: Db, slug: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return row ?? null;
}

export async function listProjects(
  db: Db,
  opts: { source?: ProjectRow['source']; includeHidden?: boolean } = {},
): Promise<ProjectRow[]> {
  const conds = [];
  if (!opts.includeHidden) conds.push(eq(projects.hidden, false));
  if (opts.source) conds.push(eq(projects.source, opts.source));
  return db.select().from(projects).where(and(...conds)).orderBy(asc(projects.id));
}

export async function insertNight(db: Db, row: NewNight): Promise<NightRow> {
  const [inserted] = await db.insert(nights).values(row).onConflictDoNothing().returning();
  if (!inserted) throw new DuplicateNight(row.projectId, row.night, row.observed ?? true);
  return inserted;
}

export async function getNights(
  db: Db,
  projectId: number,
  range: { from?: string; to?: string } = {},
): Promise<NightRow[]> {
  const conds = [eq(nights.projectId, projectId)];
  if (range.from) conds.push(gte(nights.night, range.from));
  if (range.to) conds.push(lte(nights.night, range.to));
  return db.select().from(nights).where(and(...conds)).orderBy(asc(nights.night), asc(nights.observed));
}

/** Most recent observed night (the nightly shift's row). */
export async function getLatestNightly(db: Db, projectId: number): Promise<NightRow | null> {
  const [row] = await db
    .select()
    .from(nights)
    .where(and(eq(nights.projectId, projectId), eq(nights.observed, true)))
    .orderBy(desc(nights.night))
    .limit(1);
  return row ?? null;
}

export async function insertLiveRun(db: Db, row: NewLiveRun): Promise<LiveRunRow> {
  const [r] = await db.insert(liveRuns).values(row).returning();
  if (!r) throw new Error('insertLiveRun failed');
  return r;
}

export async function updateLiveRun(db: Db, id: number, patch: Partial<NewLiveRun>): Promise<LiveRunRow> {
  const [r] = await db.update(liveRuns).set(patch).where(eq(liveRuns.id, id)).returning();
  if (!r) throw new Error(`live run ${id} not found`);
  return r;
}

/** Content-addressed: first write wins, later writes with the same hash are no-ops. */
export async function saveEvidence(
  db: Db, hash: string, projectId: number, night: string, bundle: EvidenceBundle,
): Promise<void> {
  await db.insert(evidence).values({ hash, projectId, night, bundle }).onConflictDoNothing();
}

export async function getEvidence(db: Db, hash: string): Promise<EvidenceBundle | null> {
  const [row] = await db.select().from(evidence).where(eq(evidence.hash, hash)).limit(1);
  return row?.bundle ?? null;
}

export async function saveSnapshot(
  db: Db, s: { projectId: number; adapter: string; fingerprint?: string | null; data?: unknown },
): Promise<void> {
  await db.insert(snapshots).values(s);
}

export async function getLastSnapshot(db: Db, projectId: number, adapter: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.projectId, projectId), eq(snapshots.adapter, adapter)))
    .orderBy(desc(snapshots.takenAt), desc(snapshots.id))
    .limit(1);
  return row ?? null;
}

export type BudgetField = 'llm_tokens' | 'gas_wei' | 'live_runs' | 'github_calls';
const BUDGET_COLS = {
  llm_tokens: ['llmTokens', budget.llmTokens],
  gas_wei: ['gasWei', budget.gasWei],
  live_runs: ['liveRuns', budget.liveRuns],
  github_calls: ['githubCalls', budget.githubCalls],
} as const;

/**
 * Atomically add `amount` to today's counter iff the result stays <= cap.
 * Fail-closed: returns false (value untouched) when the cap would be exceeded.
 * Single statements only (no transaction) so it works over Neon HTTP.
 */
export async function bumpBudget(
  db: Db, day: string, field: BudgetField, amount: number | bigint, cap: number | bigint,
): Promise<boolean> {
  if (!(field in BUDGET_COLS)) throw new Error(`unknown budget field: ${field}`);
  const [key, col] = BUDGET_COLS[field];
  await db.insert(budget).values({ day }).onConflictDoNothing();
  const a = amount.toString();
  const c = cap.toString();
  const rows = await db
    .update(budget)
    .set({ [key]: sql`${col} + ${a}::numeric` })
    .where(and(eq(budget.day, day), sql`${col} + ${a}::numeric <= ${c}::numeric`))
    .returning({ day: budget.day });
  return rows.length > 0;
}

/** Refund part of a reservation. Single statement; never goes below zero. */
export async function releaseBudget(db: Db, day: string, field: BudgetField, amount: number | bigint): Promise<void> {
  if (!(field in BUDGET_COLS)) throw new Error(`unknown budget field: ${field}`);
  const [key, col] = BUDGET_COLS[field];
  const a = amount.toString();
  await db
    .update(budget)
    .set({ [key]: sql`GREATEST(${col} - ${a}::numeric, 0)` })
    .where(eq(budget.day, day));
}

// ---- shifts ----

export type ShiftBudgetField = 'llm_tokens' | 'github_calls';
const SHIFT_BUDGET_COLS = {
  llm_tokens: ['llmTokens', shifts.llmTokens],
  github_calls: ['githubCalls', shifts.githubCalls],
} as const;

/** Per-shift counterpart of bumpBudget: atomic add iff the result stays <= cap. */
export async function bumpShiftBudget(
  db: Db, shiftId: number, field: ShiftBudgetField, amount: number | bigint, cap: number | bigint,
): Promise<boolean> {
  if (!(field in SHIFT_BUDGET_COLS)) throw new Error(`unknown shift budget field: ${field}`);
  const [key, col] = SHIFT_BUDGET_COLS[field];
  const a = amount.toString();
  const c = cap.toString();
  const rows = await db
    .update(shifts)
    .set({ [key]: sql`${col} + ${a}::numeric` })
    .where(and(eq(shifts.id, shiftId), sql`${col} + ${a}::numeric <= ${c}::numeric`))
    .returning({ id: shifts.id });
  return rows.length > 0;
}

export async function getShift(db: Db, id: number): Promise<ShiftRow | null> {
  const [row] = await db.select().from(shifts).where(eq(shifts.id, id)).limit(1);
  return row ?? null;
}

export async function getNightlyShift(db: Db, night: string): Promise<ShiftRow | null> {
  const [row] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.kind, 'nightly'), eq(shifts.night, night)))
    .limit(1);
  return row ?? null;
}

/** Idempotent on (nightly, night): a second call returns the existing row with created=false. */
export async function createNightlyShift(
  db: Db, s: { night: string; startedAt: Date; planned: number },
): Promise<{ shift: ShiftRow; created: boolean }> {
  const [row] = await db
    .insert(shifts)
    .values({ kind: 'nightly', night: s.night, startedAt: s.startedAt, planned: s.planned })
    .onConflictDoNothing({ target: [shifts.kind, shifts.night], where: sql`kind = 'nightly'` })
    .returning();
  if (row) return { shift: row, created: true };
  const existing = await getNightlyShift(db, s.night);
  if (!existing) throw new Error('createNightlyShift: conflict without a row');
  return { shift: existing, created: false };
}

/** One finished project run: atomic `done = done + 1`, returns the new counts. */
export async function markShiftRunDone(db: Db, shiftId: number): Promise<{ done: number; planned: number } | null> {
  const [row] = await db
    .update(shifts)
    .set({ done: sql`${shifts.done} + 1` })
    .where(eq(shifts.id, shiftId))
    .returning({ done: shifts.done, planned: shifts.planned });
  return row ?? null;
}

/** true for exactly one caller: the one that moved finished_at from NULL. */
export async function claimShiftFinalization(db: Db, shiftId: number, at: Date): Promise<boolean> {
  const rows = await db
    .update(shifts)
    .set({ finishedAt: at })
    .where(and(eq(shifts.id, shiftId), isNull(shifts.finishedAt)))
    .returning({ id: shifts.id });
  return rows.length > 0;
}

export async function updateShift(db: Db, id: number, patch: Partial<typeof shifts.$inferInsert>): Promise<void> {
  await db.update(shifts).set(patch).where(eq(shifts.id, id));
}

/**
 * Nightly shifts (at most 48 h old, newest first) that need a finalize pass: never finished and dispatched more than
 * staleMs ago, or finished with attestations still pending and last tried more than staleMs ago.
 */
export async function listStaleShifts(db: Db, now: Date, staleMs: number): Promise<ShiftRow[]> {
  const cutoff = new Date(now.getTime() - staleMs);
  const oldest = new Date(now.getTime() - 48 * 3600_000);
  return db
    .select()
    .from(shifts)
    .where(and(
      eq(shifts.kind, 'nightly'),
      gt(shifts.startedAt, oldest),
      or(
        and(isNull(shifts.finishedAt), lt(shifts.startedAt, cutoff)),
        and(eq(shifts.status, 'attest_pending'), lt(shifts.finishedAt, cutoff)),
      ),
    ))
    .orderBy(desc(shifts.startedAt))
    .limit(5);
}

// ---- attestation claims (Neon HTTP has no transactions: single statements only) ----

/** Atomically claim every unattested, unclaimed observed night of a shift. Each row goes to exactly one caller. */
export async function claimShiftNights(db: Db, shiftId: number): Promise<NightRow[]> {
  return db
    .update(nights)
    .set({ attestClaimedAt: sql`now()` })
    .where(and(
      eq(nights.shiftId, shiftId),
      eq(nights.observed, true),
      isNull(nights.attestationUid),
      isNull(nights.attestClaimedAt),
      isNotNull(nights.evidenceHash),
    ))
    .returning();
}

/** Give claimed-but-unattested rows back so a later finalize can retry them. */
export async function releaseNightClaims(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(nights)
    .set({ attestClaimedAt: null })
    .where(and(inArray(nights.id, ids), isNull(nights.attestationUid)));
}

/** Write UIDs (and the tx) for claimed rows in one statement. Never overwrites an existing UID. */
export async function setNightAttestations(db: Db, rows: { id: number; uid: string }[], tx: string): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(rows.map((r) => sql`(${r.id}::int, ${r.uid}::text)`), sql`, `);
  await db.execute(sql`
    UPDATE nights AS n SET attestation_uid = v.uid, attest_tx = ${tx}
    FROM (VALUES ${values}) AS v(id, uid)
    WHERE n.id = v.id AND n.attestation_uid IS NULL`);
}

export async function countUnattested(db: Db, shiftId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nights)
    .where(and(eq(nights.shiftId, shiftId), eq(nights.observed, true), isNull(nights.attestationUid)));
  return Number(row?.n ?? 0);
}

export async function getProjectById(db: Db, id: number): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectsByIds(db: Db, ids: number[]): Promise<ProjectRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(projects).where(inArray(projects.id, ids));
}

/** Nights (observed and reconstructed) of several projects from `from` on; per night the reconstructed row comes first. */
export async function getNightsForProjects(db: Db, ids: number[], from: string): Promise<NightRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(nights)
    .where(and(inArray(nights.projectId, ids), gte(nights.night, from)))
    .orderBy(asc(nights.night), asc(nights.observed));
}

// ---- live runs ----

/** Live runs (newest first) of one project or one requester since `since`; `beforeId` keeps only earlier rows. */
export async function recentLiveRuns(
  db: Db, by: { projectId: number } | { ipHash: string }, since: Date, beforeId?: number,
): Promise<{ id: number; startedAt: Date }[]> {
  const conds = [gt(liveRuns.startedAt, since)];
  conds.push('projectId' in by ? eq(liveRuns.projectId, by.projectId) : eq(liveRuns.requesterIpHash, by.ipHash));
  if (beforeId !== undefined) conds.push(lt(liveRuns.id, beforeId));
  return db
    .select({ id: liveRuns.id, startedAt: liveRuns.startedAt })
    .from(liveRuns)
    .where(and(...conds))
    .orderBy(desc(liveRuns.startedAt), desc(liveRuns.id))
    .limit(10);
}

export async function deleteLiveRun(db: Db, id: number): Promise<void> {
  await db.delete(liveRuns).where(eq(liveRuns.id, id));
}
