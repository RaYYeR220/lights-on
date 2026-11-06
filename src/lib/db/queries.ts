import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from './index';
import {
  projects, nights, liveRuns, evidence, snapshots, budget, shifts, trancheEvents,
  type ProjectRow, type NewProject, type NightRow, type NewNight, type LiveRunRow, type NewLiveRun, type SnapshotRow,
  type ShiftRow,
} from './schema';
import type { EvidenceBundle, TrancheFact } from '@/lib/types';

export class DuplicateNight extends Error {
  constructor(projectId: number, night: string, observed: boolean) {
    super(`night already recorded: project ${projectId}, ${night}, observed=${observed}`);
    this.name = 'DuplicateNight';
  }
}

/**
 * Insert or update by slug. A NEW project gets the next free `bay` (max+1); an existing project keeps its bay
 * (`bay` is never part of the update set). Concurrent creators can pick the same number: the unique constraint
 * rejects the loser, which simply retries with a fresh max.
 */
export async function upsertProject(db: Db, p: NewProject): Promise<ProjectRow> {
  const { slug, bay: _ignored, ...rest } = p;
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(projects)
        .values({ ...rest, slug, bay: sql<number>`(select coalesce(max(${projects.bay}), 0) + 1 from ${projects})` })
        .onConflictDoUpdate({ target: projects.slug, set: rest })
        .returning();
      if (!row) throw new Error(`upsertProject failed for ${slug}`);
      return row;
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505' && attempt < 5) continue;
      throw e;
    }
  }
}

/** Insert-only variant of upsertProject: a new project gets the next bay; an existing slug is left untouched (null). */
export async function insertProjectIfNew(db: Db, p: NewProject): Promise<ProjectRow | null> {
  const { bay: _ignored, ...rest } = p;
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(projects)
        .values({ ...rest, bay: sql<number>`(select coalesce(max(${projects.bay}), 0) + 1 from ${projects})` })
        .onConflictDoNothing({ target: projects.slug })
        .returning();
      return row ?? null;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505' && attempt < 5) continue;
      throw e;
    }
  }
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

/** Public tower/API list: visible projects minus community watches (those are unlisted, served by slug only). */
export async function listListedProjects(db: Db): Promise<ProjectRow[]> {
  return db.select().from(projects)
    .where(and(eq(projects.hidden, false), sql`${projects.source} <> 'community'`))
    .orderBy(asc(projects.id));
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

/** Refund part of a per-shift reservation; never below zero. */
export async function releaseShiftBudget(db: Db, shiftId: number, field: ShiftBudgetField, amount: number | bigint): Promise<void> {
  if (!(field in SHIFT_BUDGET_COLS)) throw new Error(`unknown shift budget field: ${field}`);
  const [key, col] = SHIFT_BUDGET_COLS[field];
  const a = amount.toString();
  await db.update(shifts).set({ [key]: sql`GREATEST(${col} - ${a}::numeric, 0)` }).where(eq(shifts.id, shiftId));
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
 * Append multiAttest txs to a shift, in order, skipping any already recorded. One statement: concurrent finalize
 * passes never lose each other's txs (the row lock serializes them and the second re-reads the appended array).
 */
export async function appendShiftTxs(db: Db, shiftId: number, txs: string[]): Promise<void> {
  const add = [...new Set(txs.filter((t) => typeof t === 'string' && t.length > 0))];
  if (add.length === 0) return;
  const arr = sql`ARRAY[${sql.join(add.map((t) => sql`${t}::text`), sql`, `)}]`;
  await db.execute(sql`
    UPDATE shifts SET attest_tx = COALESCE(shifts.attest_tx, '{}'::text[]) || ARRAY(
      SELECT u.t FROM unnest(${arr}) WITH ORDINALITY AS u(t, i)
      WHERE NOT (u.t = ANY(COALESCE(shifts.attest_tx, '{}'::text[])))
      ORDER BY u.i)
    WHERE id = ${shiftId}`);
}

/**
 * Nightly shifts (at most 48 h old, newest first) that need a finalize pass: never finished and dispatched more than
 * staleMs ago; or finished but still `attest_pending` / left `running` (a finalize died before its status write),
 * last tried more than staleMs ago.
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
        and(inArray(shifts.status, ['attest_pending', 'running']), lt(shifts.finishedAt, cutoff)),
      ),
    ))
    .orderBy(desc(shifts.startedAt))
    .limit(5);
}

/** One finalize pass at a time per shift: true for exactly one caller until the lease runs out. */
export async function leaseShift(db: Db, shiftId: number, now: Date, ms: number): Promise<boolean> {
  const rows = await db
    .update(shifts)
    .set({ leaseUntil: new Date(now.getTime() + ms) })
    .where(and(eq(shifts.id, shiftId), or(isNull(shifts.leaseUntil), lte(shifts.leaseUntil, now))))
    .returning({ id: shifts.id });
  return rows.length > 0;
}

// ---- attestation claims (Neon HTTP has no transactions: single statements only) ----
// A claim is a token (attest_claim_id, a fresh uuid per claim statement). Every later write to claimed rows presents
// it, so a pass can only ever touch rows it claimed itself, never a newer claim of another pass.

/** A claim with no persisted tx this old is taken over by the next claim (its holder died before signing). */
export const RECLAIM_AFTER_MS = 10 * 60_000;

/**
 * Rows a claim statement may take: unclaimed, or claimed more than RECLAIM_AFTER_MS ago with no tx persisted. A tx can
 * only be sent after its hash is persisted under the claim token, so a tx-less claim has nothing on chain; the old
 * holder's late persist then matches 0 rows (the token changed), so it never sends.
 */
const claimable = (shiftId: number, at: Date) => and(
  eq(nights.shiftId, shiftId),
  eq(nights.observed, true),
  isNull(nights.attestationUid),
  isNotNull(nights.evidenceHash),
  or(
    isNull(nights.attestClaimedAt),
    and(isNull(nights.attestTx), lt(nights.attestClaimedAt, new Date(at.getTime() - RECLAIM_AFTER_MS))),
  ),
);

/**
 * Atomically claim up to `limit` claimable nights of a shift (lowest ids first) under `claimId`. Each row goes to one
 * caller. Taking over a stale tx-less claim is part of the same statement: release and re-claim are one write.
 */
export async function claimShiftNights(db: Db, shiftId: number, at: Date, claimId: string, limit: number): Promise<NightRow[]> {
  const ids = db.select({ id: nights.id }).from(nights).where(claimable(shiftId, at)).orderBy(asc(nights.id)).limit(limit);
  const rows = await db
    .update(nights)
    .set({ attestClaimedAt: at, attestClaimId: claimId })
    .where(and(inArray(nights.id, ids), claimable(shiftId, at)))
    .returning();
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Give claimed-but-unattested rows back (forgetting any tx/nonce) so a later pass can retry them. Only rows still held
 * under `claimId` (and, from a reconcile, still carrying the checked `tx`) are touched. Only for batches that were
 * never broadcast, or whose tx reverted or can no longer mine.
 */
export async function releaseNightClaims(db: Db, ids: number[], claimId: string, tx?: string): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(nights)
    .set({ attestClaimedAt: null, attestClaimId: null, attestTx: null, attestNonce: null, attestSender: null, attestSentAt: null })
    .where(and(
      inArray(nights.id, ids),
      isNull(nights.attestationUid),
      eq(nights.attestClaimId, claimId),
      ...(tx !== undefined ? [eq(nights.attestTx, tx)] : []),
    ));
}

/**
 * Record the signed tx (+ nonce + sender) on our claimed batch, before it is sent or while its outcome is unknown.
 * A null nonce/sender never erases one already recorded; `attest_sent_at` keeps the FIRST persist time (`at`).
 * Returns how many rows were written: fewer than `ids` means some row is no longer held under `claimId` (or already
 * carries another tx), and the caller must then not send.
 */
export async function markNightsBroadcast(
  db: Db, ids: number[], claimId: string, tx: string, nonce: number | null, sender: string | null, at: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(nights)
    .set({
      attestTx: tx,
      attestNonce: sql`COALESCE(${nonce}::int, ${nights.attestNonce})`,
      attestSender: sql`COALESCE(${sender}::text, ${nights.attestSender})`,
      attestSentAt: sql`COALESCE(${nights.attestSentAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(and(
      inArray(nights.id, ids),
      isNull(nights.attestationUid),
      eq(nights.attestClaimId, claimId),
      or(isNull(nights.attestTx), eq(nights.attestTx, tx)), // never swaps the tx of a batch
    ))
    .returning({ id: nights.id });
  return rows.length;
}

/** Claimed rows of a shift with a broadcast tx but no uid yet, in batch order (id ascending). */
export async function listUnconfirmedBroadcasts(db: Db, shiftId: number): Promise<NightRow[]> {
  return db
    .select()
    .from(nights)
    .where(and(
      eq(nights.shiftId, shiftId),
      isNull(nights.attestationUid),
      isNotNull(nights.attestClaimId),
      isNotNull(nights.attestTx),
    ))
    .orderBy(asc(nights.id));
}

/**
 * Write UIDs (and the tx) for rows held under `claimId`, in one statement. Never overwrites a UID, and never writes
 * over a different tx than the one these uids came from. Returns how many rows were actually written.
 */
export async function setNightAttestations(
  db: Db, rows: { id: number; uid: string }[], tx: string, claimId: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = sql.join(rows.map((r) => sql`(${r.id}::int, ${r.uid}::text)`), sql`, `);
  const res = await db.execute(sql`
    UPDATE nights AS n SET attestation_uid = v.uid, attest_tx = ${tx}
    FROM (VALUES ${values}) AS v(id, uid)
    WHERE n.id = v.id AND n.attestation_uid IS NULL AND n.attest_claim_id = ${claimId}
      AND (n.attest_tx IS NULL OR n.attest_tx = ${tx})
    RETURNING n.id`);
  return (res as unknown as { rows: unknown[] }).rows.length;
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

/**
 * Backfill-only write: insert or replace a RECONSTRUCTED night (observed=false). Refuses observed rows, and
 * the conflict target includes `observed`, so an observed row can never be touched. Never carries attestation fields.
 */
export async function upsertReconstructedNight(db: Db, row: NewNight): Promise<NightRow> {
  if (row.observed !== false) throw new Error('upsertReconstructedNight only writes observed=false rows');
  const [saved] = await db
    .insert(nights)
    .values(row)
    .onConflictDoUpdate({
      target: [nights.projectId, nights.night, nights.observed],
      set: { status: row.status, signals: row.signals ?? null, evidenceHash: row.evidenceHash ?? null },
    })
    .returning();
  if (!saved) throw new Error('upsertReconstructedNight failed');
  return saved;
}

/**
 * Backfill cleanup: remove RECONSTRUCTED git-only nights of one project before its first commit.
 * Single guarded DELETE: this project, observed=false, night before `beforeDate`, evidence from git alone.
 */
export async function deleteReconstructedGitNightsBefore(db: Db, projectId: number, beforeDate: string): Promise<number> {
  const rows = await db
    .delete(nights)
    .where(and(
      eq(nights.projectId, projectId),
      eq(nights.observed, false),
      lt(nights.night, beforeDate),
      sql`${nights.signals}->>'source' = 'git'`,
    ))
    .returning({ id: nights.id });
  return rows.length;
}

// ---- tranches (challenge windows) ----

export type TrancheRow = typeof trancheEvents.$inferSelect;

/**
 * Record a campaign's tranche schedule as read by the vibestarter adapter: one row per (project, tranche index), one
 * statement. The window end follows the latest read; a request time or paid amount once seen is never erased by a
 * read that lacks it. `alerted` is left alone.
 */
export async function upsertTrancheEvents(db: Db, projectId: number, tranches: TrancheFact[]): Promise<number> {
  const date = (v: string | null) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  };
  const byIndex = new Map<number, TrancheFact>();
  for (const t of tranches) if (Number.isInteger(t.index) && t.index >= 0 && t.index < 1000) byIndex.set(t.index, t);
  if (byIndex.size === 0) return 0;
  const rows = await db
    .insert(trancheEvents)
    .values([...byIndex.values()].map((t) => ({
      projectId,
      trancheIndex: t.index,
      requestedAt: date(t.requestedAt),
      windowEndsAt: date(t.windowEndsAt),
      amountWei: t.amountPaidWei && /^\d{1,78}$/.test(t.amountPaidWei) ? t.amountPaidWei : null,
    })))
    .onConflictDoUpdate({
      target: [trancheEvents.projectId, trancheEvents.trancheIndex],
      set: {
        requestedAt: sql`COALESCE(excluded.requested_at, ${trancheEvents.requestedAt})`,
        windowEndsAt: sql`excluded.window_ends_at`,
        amountWei: sql`COALESCE(excluded.amount_wei, ${trancheEvents.amountWei})`,
      },
    })
    .returning({ i: trancheEvents.trancheIndex });
  return rows.length;
}

/**
 * Tranche schedules of several projects, by project, index ascending. From `tranche_events` (written by every shift
 * run); a project with no rows there yet falls back to the tranches in its latest evidence bundle with a readable
 * vibestarter source.
 */
export async function getTrancheSchedules(db: Db, ids: number[]): Promise<Map<number, TrancheRow[]>> {
  const out = new Map<number, TrancheRow[]>();
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return out;
  const rows = await db.select().from(trancheEvents)
    .where(inArray(trancheEvents.projectId, uniq))
    .orderBy(asc(trancheEvents.projectId), asc(trancheEvents.trancheIndex));
  for (const r of rows) out.set(r.projectId, [...(out.get(r.projectId) ?? []), r]);
  const missing = uniq.filter((id) => !out.has(id));
  if (missing.length === 0) return out;
  const res = await db.execute(sql`
    SELECT DISTINCT ON (e.project_id) e.project_id AS "projectId", e.bundle #> '{sources,vibestarter,facts,tranches}' AS tranches
    FROM evidence e
    WHERE e.project_id IN (${sql.join(missing.map((id) => sql`${id}`), sql`, `)})
      AND e.bundle #>> '{sources,vibestarter,ok}' = 'true'
      AND jsonb_typeof(e.bundle #> '{sources,vibestarter,facts,tranches}') = 'array'
    ORDER BY e.project_id, e.night DESC`);
  const date = (v: unknown) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  };
  for (const r of (res as unknown as { rows: { projectId: number; tranches: unknown }[] }).rows) {
    const list = (Array.isArray(r.tranches) ? r.tranches : [])
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && Number.isInteger((t as { index?: unknown }).index))
      .map((t): TrancheRow => ({
        projectId: Number(r.projectId),
        trancheIndex: t.index as number,
        requestedAt: date(t.requestedAt),
        windowEndsAt: date(t.windowEndsAt),
        amountWei: typeof t.amountPaidWei === 'string' && /^\d{1,78}$/.test(t.amountPaidWei) ? t.amountPaidWei : null,
        tx: null,
        alerted: false,
      }))
      .sort((a, b) => a.trancheIndex - b.trancheIndex);
    if (list.length) out.set(Number(r.projectId), list);
  }
  return out;
}

// ---- notifications ----

/** Earliest still-open challenge window per project (window ends after `now`). */
export async function getOpenTranches(db: Db, ids: number[], now: Date): Promise<TrancheRow[]> {
  if (ids.length === 0) return [];
  const out: TrancheRow[] = [];
  for (const list of (await getTrancheSchedules(db, ids)).values()) {
    const open = list
      .filter((t) => t.windowEndsAt && t.windowEndsAt.getTime() > now.getTime())
      .sort((a, b) => a.windowEndsAt!.getTime() - b.windowEndsAt!.getTime())[0];
    if (open) out.push(open);
  }
  return out.sort((a, b) => a.windowEndsAt!.getTime() - b.windowEndsAt!.getTime());
}

/** Latest nightly shift that has finished. */
export async function getLatestFinishedNightly(db: Db): Promise<ShiftRow | null> {
  const [row] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.kind, 'nightly'), isNotNull(shifts.finishedAt)))
    .orderBy(desc(shifts.night))
    .limit(1);
  return row ?? null;
}

// ---- open surfaces (REST / MCP) ----

export interface NightStatusRow {
  projectId: number; night: string; status: NightRow['status']; observed: boolean;
  summary: string | null; createdAt: Date; evidenceHash: string | null; attestationUid: string | null;
}

/** Lean per-night rows (no signals/notable) of several projects from `from` on, oldest first. */
export async function getNightStatuses(db: Db, ids: number[], from: string): Promise<NightStatusRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      projectId: nights.projectId, night: nights.night, status: nights.status, observed: nights.observed,
      summary: nights.summary, createdAt: nights.createdAt, evidenceHash: nights.evidenceHash,
      attestationUid: nights.attestationUid,
    })
    .from(nights)
    .where(and(inArray(nights.projectId, ids), gte(nights.night, from)))
    .orderBy(asc(nights.night), asc(nights.observed));
}

/** One project's tranche schedule (tranche_events, else the latest vibestarter evidence), index ascending. */
export async function getTranches(db: Db, projectId: number): Promise<TrancheRow[]> {
  return (await getTrancheSchedules(db, [projectId])).get(projectId) ?? [];
}

export async function getProjectByLiveUrl(db: Db, liveUrl: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projects).where(eq(projects.liveUrl, liveUrl)).limit(1);
  return row ?? null;
}

export async function setProjectHidden(db: Db, id: number, hidden: boolean): Promise<void> {
  await db.update(projects).set({ hidden }).where(eq(projects.id, id));
}

export async function deleteProjectById(db: Db, id: number): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

/**
 * Community watches created since `since` by the `addedBy` marker (`watch:<ip hash>`), or all `watch:` rows when
 * `addedBy` is omitted. `beforeId` keeps only earlier rows (reserve-then-verify, like the live-run limiter).
 */
export async function countWatches(db: Db, since: Date, addedBy?: string, beforeId?: number): Promise<number> {
  const conds = [gte(projects.createdAt, since), addedBy ? eq(projects.addedBy, addedBy) : sql`${projects.addedBy} like 'watch:%'`];
  if (beforeId !== undefined) conds.push(lt(projects.id, beforeId));
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(...conds));
  return r?.n ?? 0;
}

// ---- moderation (marker lives in added_by; no schema change) ----

/** Unhide a watched project after its first run, but only while it is still a `watch:` row (never a moderated one). */
export async function unhideWatchProject(db: Db, id: number): Promise<boolean> {
  const r = await db.update(projects).set({ hidden: false })
    .where(and(eq(projects.id, id), sql`${projects.addedBy} like 'watch:%'`)).returning({ id: projects.id });
  return r.length > 0;
}

/** hide: hidden=true, added_by='moderated:<iso>:<previous>'. unhide: restore the previous added_by and show it. */
export async function moderateProject(db: Db, slug: string, action: 'hide' | 'unhide', at: Date = new Date()): Promise<ProjectRow | null> {
  const p = await getProjectBySlug(db, slug);
  if (!p) return null;
  if (action === 'hide') {
    const addedBy = p.addedBy?.startsWith('moderated:') ? p.addedBy : `moderated:${at.toISOString()}:${p.addedBy ?? ''}`;
    const [row] = await db.update(projects).set({ hidden: true, addedBy }).where(eq(projects.id, p.id)).returning();
    return row ?? null;
  }
  const prev = p.addedBy?.startsWith('moderated:') ? p.addedBy.slice('moderated:'.length + 24 + 1) : p.addedBy; // ISO timestamp is 24 chars
  const [row] = await db.update(projects).set({ hidden: false, addedBy: prev || null }).where(eq(projects.id, p.id)).returning();
  return row ?? null;
}
