import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from './index';
import {
  projects, nights, liveRuns, evidence, snapshots, budget,
  type ProjectRow, type NewProject, type NightRow, type NewNight, type LiveRunRow, type NewLiveRun, type SnapshotRow,
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
