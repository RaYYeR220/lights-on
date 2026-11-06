import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { projects, type ProjectRow } from '@/lib/db/schema';
import { computeRecord } from '@/lib/shift/rules';
import { nightNumber, nightDate, shiftStartFor } from '@/lib/shift/night';
import { sanitizeSummary } from '@/lib/shift/explain';
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

interface NightViewRow {
  projectId: number;
  night: string;
  status: Status;
  observed: boolean;
  attested: boolean;
  summary: string | null;
  notable: unknown;
  aiModel: string | null;
  reasons: unknown;
  createdAt: string | null;
  work: { commits?: unknown; releases?: unknown } | null;
}

/** yyyymmdd numbers of the `count` nights ending at `last`, oldest first. */
export function nightsEndingAt(last: number, count: number): number[] {
  const s = String(last);
  const base = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Array.from({ length: count }, (_, i) => nightNumber(new Date(base - (count - 1 - i) * DAY_MS)));
}

const BANNED = /\b(scam|rug|dead|abandoned|fraud)\b/i;

/** Cut to <= n chars at a word boundary, with an ellipsis when cut. */
function clip(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(-]+$/, '')}…`;
}

/** AI-written lines (summary / notable) go through the same sanitizer the shift uses. */
function aiLine(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = sanitizeSummary(s);
  return t ? clip(t, 140) : null;
}

/** A commit subject as plain text: first line, no HTML, no URLs, no markdown emphasis; merges skipped. */
function commitLine(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  let t = s.split('\n')[0] ?? '';
  if (/^Merge (pull request|branch|remote-tracking|tag)\b/i.test(t)) return null;
  t = t.replace(/<[^>]*>/g, ' ').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/[`*_]{1,3}/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || BANNED.test(t)) return null;
  return clip(t, 100);
}

function releaseLine(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null;
  const { name, tag } = r as { name?: unknown; tag?: unknown };
  const n = typeof name === 'string' && name.trim() ? name.trim() : null;
  const t = typeof tag === 'string' && tag.trim() ? tag.trim() : null;
  const line = n ?? (t ? `Release ${t}` : null);
  return line ? commitLine(line) : null;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function whatShipped(row: NightViewRow | undefined): string[] {
  if (!row || (row.status !== 'shipped' && row.status !== 'building')) return [];
  const out: string[] = [];
  const push = (s: string | null) => {
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const n of asArray(row.notable)) push(aiLine(n));
  // A summary counts only when a model wrote it; the no-AI fallbacks are generic templates.
  if (out.length === 0 && row.aiModel) push(aiLine(row.summary));
  if (row.status === 'shipped') {
    for (const r of asArray(row.work?.releases)) push(releaseLine(r));
    const reasons = asArray(row.reasons);
    if (reasons.includes('liveapp.new_deploy')) push('New deploy seen on the live app');
    if (reasons.includes('chain.new_deployment')) push('New contract deployment');
  }
  for (const c of asArray(row.work?.commits)) push(commitLine(c));
  return out.slice(0, 2);
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
        CASE WHEN x.latest AND x.status IN ('shipped', 'building') THEN (
          SELECT jsonb_build_object(
            'commits', (
              SELECT coalesce(jsonb_agg(c.m ORDER BY c.o), '[]'::jsonb) FROM (
                SELECT t.el ->> 'message' AS m, t.o
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.bundle #> '{sources,repo,facts,commits}') = 'array'
                  THEN e.bundle #> '{sources,repo,facts,commits}' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(el, o)
                WHERE t.el ->> 'kind' = 'code' AND coalesce((t.el ->> 'authorIsBot')::boolean, false) = false
                ORDER BY t.o LIMIT 8
              ) c
            ),
            'releases', (
              SELECT coalesce(jsonb_agg(r.v ORDER BY r.o), '[]'::jsonb) FROM (
                SELECT jsonb_build_object('name', t.el ->> 'name', 'tag', t.el ->> 'tag') AS v, t.o
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.bundle #> '{sources,repo,facts,releases}') = 'array'
                  THEN e.bundle #> '{sources,repo,facts,releases}' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(el, o)
                ORDER BY t.o LIMIT 2
              ) r
            )
          ) FROM evidence e WHERE e.hash = x.evidence_hash
        ) END AS work
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
