import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { projects, type ProjectRow } from '@/lib/db/schema';
import { computeRecord } from '@/lib/shift/rules';
import { nightNumber, nightDate, shiftStartFor } from '@/lib/shift/night';
import { sanitizeSummary } from '@/lib/shift/explain';
import { whatShipped, workSql, type WorkRow } from './work';
import type { Status } from '@/lib/types';

/** Nights carried by every window: 9 x 10 lites, oldest top left, the latest night bottom right. */
export const TOWER_NIGHTS = 90;
const DAY_MS = 86_400_000;

export interface TowerProject {
  slug: string;
  name: string;
  source: ProjectRow['source'];
  /** Latest observed night's status; when no observed night exists, the latest reconstructed one (statusObserved=false). */
  status: Status | null;
  statusObserved: boolean;
  /** yyyymmdd of the night `status` comes from. */
  statusNight: number | null;
  summary: string | null;
  /** Up to 2 short, sanitized lines of real work behind a shipped/building status (never invented). */
  whatShipped: string[];
  /** The last TOWER_NIGHTS nights, oldest to newest; null where no row exists. */
  history: (Status | null)[];
  /** Per night: true where the observed row was used, false where only a reconstructed row exists (or none). */
  observed: boolean[];
  lit30: number;
  streak: number;
  /** created_at of the latest observed night: the order the shift confirmed projects in. */
  confirmedAt: string | null;
  reconstructedNights: number;
}

export interface TowerData {
  generatedAt: string;
  /** Latest observed (live) night in the window, yyyymmdd; null while only reconstructed history exists. */
  night: number | null;
  /** Newest night of the window (the latest scheduled shift), yyyymmdd. */
  lastNight: number;
  /** Projects whose observed row on `night` is shipped; null when `night` is null. */
  shippedOnNight: number | null;
  /** At least one observed row on `night` carries an attestation UID. */
  attested: boolean;
  projects: TowerProject[];
}

interface NightViewRow extends WorkRow {
  projectId: number;
  night: string;
  observed: boolean;
  attested: boolean;
  createdAt: string | null;
}

/** yyyymmdd numbers of the `count` nights ending at `last`, oldest first. */
export function nightsEndingAt(last: number, count: number): number[] {
  const s = String(last);
  const base = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Array.from({ length: count }, (_, i) => nightNumber(new Date(base - (count - 1 - i) * DAY_MS)));
}

const toIso = (v: string | null): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const nightNum = (d: string) => Number(d.slice(0, 10).replace(/-/g, ''));

interface Orderable {
  source: string;
  name: string;
  slug: string;
  /** Stored window position (a planned projects.bay column); used first when present. */
  bay?: unknown;
}
const bayOf = (p: Orderable): number | null => (typeof p.bay === 'number' && Number.isFinite(p.bay) ? p.bay : null);

/** Deterministic window order: by stored bay when a project has one, else by source, then name (case-insensitive), then slug. */
export function towerOrder(a: Orderable, b: Orderable): number {
  const ab = bayOf(a);
  const bb = bayOf(b);
  if (ab !== null || bb !== null) {
    if (ab === null) return 1;
    if (bb === null) return -1;
    if (ab !== bb) return ab - bb;
  }
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Everything the landing tower needs, in two queries (projects; the 90-night window with the latest rows' detail).
 * Per night the observed row wins over the reconstructed one; nights with no row stay null.
 */
export async function getTowerData(db: Db, opts: { now?: Date } = {}): Promise<TowerData> {
  const now = opts.now ?? new Date();
  const lastNight = nightNumber(shiftStartFor(now));
  const window = nightsEndingAt(lastNight, TOWER_NIGHTS);
  const from = nightDate(window[0]);
  const to = nightDate(lastNight);

  const [projRows, res] = await Promise.all([
    // every column, so a future `bay` column is picked up without a change here
    db.select().from(projects).where(eq(projects.hidden, false)),
    db.execute(sql`
      SELECT x.project_id AS "projectId", x.night::text AS night, x.status, x.observed, x.attested,
        CASE WHEN x.latest THEN x.summary END AS summary,
        CASE WHEN x.latest THEN x.notable END AS notable,
        CASE WHEN x.latest THEN x.ai_model END AS "aiModel",
        CASE WHEN x.latest THEN x.signals -> 'reasons' END AS reasons,
        CASE WHEN x.latest AND x.observed THEN to_json(x.created_at) #>> '{}' END AS "createdAt",
        CASE WHEN x.latest AND x.status IN ('shipped', 'building') THEN ${workSql(sql.raw('x.evidence_hash'))} END AS work
      FROM (
        SELECT n.*, n.attestation_uid IS NOT NULL AS attested,
          n.night = max(n.night) OVER (PARTITION BY n.project_id, n.observed) AS latest
        FROM nights n
        WHERE n.night >= ${from}::date AND n.night <= ${to}::date
      ) x
      ORDER BY x.night, x.observed`),
  ]);
  const visible = new Set(projRows.map((p) => p.id));
  const rows = (res as unknown as { rows: NightViewRow[] }).rows.filter((r) => visible.has(r.projectId));

  const byProject = new Map<number, NightViewRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectId);
    if (list) list.push(r);
    else byProject.set(r.projectId, [r]);
  }

  const index = new Map(window.map((n, i) => [n, i]));
  let night: number | null = null;
  for (const r of rows) if (r.observed) night = Math.max(night ?? 0, nightNum(r.night));
  let shippedOnNight: number | null = night === null ? null : 0;
  let attested = false;

  const ordered = [...projRows].sort(towerOrder);
  const out: TowerProject[] = ordered.map((p) => {
    const mine = byProject.get(p.id) ?? [];
    const history: (Status | null)[] = Array(TOWER_NIGHTS).fill(null);
    const observed: boolean[] = Array(TOWER_NIGHTS).fill(false);
    let latestObs: NightViewRow | undefined;
    let latestRec: NightViewRow | undefined;
    for (const r of mine) {
      const n = nightNum(r.night);
      const i = index.get(n);
      if (i === undefined) continue;
      if (r.observed) {
        history[i] = r.status;
        observed[i] = true;
        if (!latestObs || n > nightNum(latestObs.night)) latestObs = r;
        if (n === night) {
          if (r.status === 'shipped') shippedOnNight = (shippedOnNight ?? 0) + 1;
          if (r.attested) attested = true;
        }
      } else {
        if (!observed[i]) history[i] = r.status;
        if (!latestRec || n > nightNum(latestRec.night)) latestRec = r;
      }
    }
    const statusRow = latestObs ?? latestRec;
    const record = computeRecord(
      history.flatMap((s, i) => (s ? [{ night: window[i], status: s }] : [])),
      lastNight,
    );
    let reconstructedNights = 0;
    for (let i = 0; i < TOWER_NIGHTS; i++) if (history[i] && !observed[i]) reconstructedNights++;
    return {
      slug: p.slug,
      name: p.name,
      source: p.source,
      status: statusRow?.status ?? null,
      statusObserved: Boolean(latestObs),
      statusNight: statusRow ? nightNum(statusRow.night) : null,
      summary: statusRow?.summary ? sanitizeSummary(statusRow.summary) : null,
      whatShipped: whatShipped(statusRow),
      history,
      observed,
      lit30: record.lit30,
      streak: record.streak,
      confirmedAt: toIso(latestObs?.createdAt ?? null),
      reconstructedNights,
    };
  });

  return { generatedAt: now.toISOString(), night, lastNight, shippedOnNight, attested, projects: out };
}
