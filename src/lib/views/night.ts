import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { nights, projects, shifts } from '@/lib/db/schema';
import { nightDate, nightOf } from '@/lib/shift/night';
import type { Status } from '@/lib/types';
import { towerOrder } from './tower';
import { whatShipped, workSql, type WorkRow } from './work';
import { sanitizeSummary } from '@/lib/shift/explain';

export interface ShiftRowView {
  slug: string;
  name: string;
  source: string;
  status: Status;
  observed: boolean;
  /** AI explanation (sanitized), or null. */
  summary: string | null;
  whatShipped: string[];
  evidenceHash: string | null;
  attestationUid: string | null;
  attestTx: string | null;
  confirmedAt: string | null;
}

export interface NightView {
  /**
   * observed: a live shift ran for this night. preview: no live night yet (or none for the asked date), showing
   * reconstructed history instead, clearly labelled. empty: nothing at all for that night.
   */
  mode: 'observed' | 'preview' | 'empty';
  night: number | null;
  /** The newest observed night anywhere; null before the first live shift. */
  latestObserved: number | null;
  shift: { attestTxs: string[]; startedAt: string; finishedAt: string | null; planned: number; done: number; status: string } | null;
  rows: ShiftRowView[];
  counts: Record<Status, number>;
  /** Distinct attestation transactions of the shift (one root attestation per batch of up to 500), in send order. */
  txs: string[];
  /**
   * One entry per tx (same order): the root attestation's uid and Merkle root, the night manifest that lists its
   * leaves, and how many project-nights it covers (every observed row carrying that tx, listed or not).
   */
  attestations: NightAttestationView[];
  /** Neighbouring observed nights, for navigation. */
  prev: number | null;
  next: number | null;
  /** When the view was built (ms). */
  generatedAt: number;
}

export interface NightAttestationView { tx: string; uid: string | null; root: string | null; manifest: string | null; count: number }

interface Raw extends WorkRow {
  slug: string;
  name: string;
  source: string;
  hidden: boolean;
  observed: boolean;
  evidenceHash: string | null;
  attestationUid: string | null;
  attestTx: string | null;
  attestRoot: string | null;
  attestManifest: string | null;
  createdAt: Date | string | null;
}

const ZERO: Record<Status, number> = { shipped: 0, building: 0, quiet: 0, down: 0, unavailable: 0 };

async function rowsFor(db: Db, date: string, observed: boolean): Promise<Raw[]> {
  return (await db
    .select({
      slug: projects.slug,
      name: projects.name,
      source: projects.source,
      hidden: projects.hidden,
      status: nights.status,
      observed: nights.observed,
      summary: nights.summary,
      notable: nights.notable,
      aiModel: nights.aiModel,
      reasons: sql<unknown>`${nights.signals} -> 'reasons'`,
      work: sql<WorkRow['work']>`CASE WHEN ${nights.status} IN ('shipped', 'building') THEN ${workSql(sql`${nights.evidenceHash}`)} END`,
      evidenceHash: nights.evidenceHash,
      attestationUid: nights.attestationUid,
      attestTx: nights.attestTx,
      attestRoot: nights.attestRoot,
      attestManifest: nights.attestManifest,
      createdAt: nights.createdAt,
    })
    .from(nights)
    .innerJoin(projects, eq(projects.id, nights.projectId))
    .where(and(eq(nights.night, date), eq(nights.observed, observed)))) as Raw[];
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const TX = /^0x[0-9a-fA-F]{64}$/;

/**
 * One entry per tx hash: the shift's recorded txs (send order) first, then any only seen on rows. Each value is split
 * on commas (rows written before migration 0011 joined several hashes into one string) and kept only if it is a hash,
 * so a link can never point at a joined or malformed value.
 */
export function shiftTxs(shiftTxList: string[] | null, rowTxs: (string | null)[]): string[] {
  const out = new Set<string>();
  for (const v of [...(shiftTxList ?? []), ...rowTxs]) {
    for (const t of (v ?? '').split(',')) {
      const h = t.trim();
      if (TX.test(h)) out.add(h.toLowerCase());
    }
  }
  return [...out];
}

/** Per tx: the root attestation it carries, from every observed row of the night (hidden or community ones included). */
export function attestationsOf(txs: string[], raw: Pick<Raw, 'attestTx' | 'attestationUid' | 'attestRoot' | 'attestManifest'>[]): NightAttestationView[] {
  return txs.map((tx) => {
    const mine = raw.filter((r) => (r.attestTx ?? '').toLowerCase() === tx);
    const first = mine.find((r) => r.attestationUid) ?? mine[0];
    return { tx, uid: first?.attestationUid ?? null, root: first?.attestRoot ?? null, manifest: first?.attestManifest ?? null, count: mine.length };
  });
}

function view(raw: Raw[]): Pick<NightView, 'rows' | 'counts'> {
  const rows = raw
    .filter((r) => !r.hidden && r.source !== 'community') // unlisted projects stay off the shift page
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      source: r.source,
      status: r.status,
      observed: r.observed,
      summary: r.aiModel && r.summary ? sanitizeSummary(r.summary) : null,
      whatShipped: whatShipped(r, 3),
      evidenceHash: r.evidenceHash,
      attestationUid: r.attestationUid,
      attestTx: r.attestTx,
      confirmedAt: iso(r.createdAt),
    }));
  // the shift's own order when it ran live; the building's order for previews
  rows.sort((a, b) =>
    a.observed && b.observed && a.confirmedAt && b.confirmedAt
      ? a.confirmedAt.localeCompare(b.confirmedAt)
      : towerOrder(a, b),
  );
  const counts = { ...ZERO };
  for (const r of rows) counts[r.status]++;
  return { rows, counts };
}

/**
 * The shift for one night (observed rows only). Without a date: the latest observed night, or, before the first
 * live shift, the latest reconstructed night as a labelled preview.
 */
export async function getNightView(db: Db, night?: number, opts: { now?: Date } = {}): Promise<NightView> {
  const generatedAt = (opts.now ?? new Date()).getTime();
  return { ...(await buildNightView(db, night)), generatedAt };
}

async function buildNightView(db: Db, night?: number): Promise<Omit<NightView, 'generatedAt'>> {
  const [latest] = await db
    .select({ n: sql<string | null>`max(${nights.night})::text` })
    .from(nights)
    .where(eq(nights.observed, true));
  const latestObserved = latest?.n ? nightOf(latest.n) : null;
  const target = night ?? latestObserved;

  if (target !== null) {
    const date = nightDate(target);
    const [raw, shiftRows, around] = await Promise.all([
      rowsFor(db, date, true),
      db.select().from(shifts).where(and(eq(shifts.kind, 'nightly'), eq(shifts.night, date))).limit(1),
      db
        .select({
          prev: sql<string | null>`max(${nights.night}) FILTER (WHERE ${nights.night} < ${date}::date)::text`,
          next: sql<string | null>`min(${nights.night}) FILTER (WHERE ${nights.night} > ${date}::date)::text`,
        })
        .from(nights)
        .where(eq(nights.observed, true)),
    ]);
    const s = shiftRows[0];
    const nav = { prev: around[0]?.prev ? nightOf(around[0].prev) : null, next: around[0]?.next ? nightOf(around[0].next) : null };
    if (raw.length) {
      const v = view(raw);
      const txs = shiftTxs(s?.attestTxs ?? null, v.rows.map((r) => r.attestTx));
      return {
        mode: 'observed', night: target, latestObserved, rows: v.rows, counts: v.counts, txs, attestations: attestationsOf(txs, raw), ...nav,
        shift: s
          ? { attestTxs: shiftTxs(s.attestTxs ?? null, []), startedAt: s.startedAt.toISOString(), finishedAt: s.finishedAt?.toISOString() ?? null, planned: s.planned, done: s.done, status: s.status }
          : null,
      };
    }
    if (night !== undefined) {
      // no live shift for the asked night: show its reconstructed rows, if any, as a preview
      const rec = await rowsFor(db, date, false);
      const v = view(rec);
      return { mode: rec.length ? 'preview' : 'empty', night: target, latestObserved, shift: null, txs: [], attestations: [], ...v, ...nav };
    }
  }

  // before the first live night: the newest reconstructed night, labelled as a preview
  const [lr] = await db
    .select({ n: sql<string | null>`max(${nights.night})::text` })
    .from(nights)
    .where(eq(nights.observed, false));
  if (!lr?.n) return { mode: 'empty', night: null, latestObserved, shift: null, rows: [], counts: { ...ZERO }, txs: [], attestations: [], prev: null, next: null };
  const v = view(await rowsFor(db, lr.n, false));
  return { mode: 'preview', night: nightOf(lr.n), latestObserved, shift: null, txs: [], attestations: [], prev: null, next: null, ...v };
}

/** Newest observed nights first (for the night index). */
export async function listObservedNights(db: Db, limit = 30): Promise<number[]> {
  const rows = await db
    .selectDistinct({ n: sql<string>`${nights.night}::text` })
    .from(nights)
    .where(eq(nights.observed, true))
    .orderBy(desc(sql`${nights.night}::text`))
    .limit(limit);
  return rows.map((r) => nightOf(r.n));
}
