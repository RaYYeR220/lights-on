/**
 * Pure functions for the Vibeathon / Base field study. Every number the README, site and video quote comes from
 * these functions run over the real database (scripts/study.ts), never typed by hand.
 * Nights are 'YYYY-MM-DD' strings (UTC dates); string order == date order.
 */

export const BASIS = 'reconstructed history (git + Wayback), not attested';
export const V01_RESULTS_DATE = '2026-07-30';

/** A project counts toward a 30-night statistic only with at least this many non-unavailable nights in the window. */
export const MIN_FULL_NIGHTS_30 = 25;

export type Cohort = 'vibeathon01' | 'hackathon' | 'reference' | 'vibestarter';
export const COHORTS: Cohort[] = ['vibeathon01', 'hackathon', 'reference', 'vibestarter'];

/** The 8 well-known reference apps: `base` entries with `reference: true` in data/seed-projects.json. */
export const REFERENCE_APPS = [
  'Uniswap Interface', 'Aave Interface', 'CoW Swap', 'Safe{Wallet}', 'Revoke.cash', 'base.org', 'Blockscout (Base)', 'Nouns Builder',
] as const;

/** The 10 Vibeathon 01 finalists (seed file `vibeathon01`); Corvo Edge and Onetoken are source=vibestarter in the DB now. */
export const V01_FINALISTS = [
  'Corvo Edge', 'Onetoken', 'aHand', 'FutureRoots', 'exSafe', 'EventChain', 'Lineage', 'Grayl AI', 'Agent Verse', 'AIDOL',
] as const;

export interface ProjectLite { slug: string; name: string; source: string; repo: string | null }
export interface NightLite { night: string; status: string; observed?: boolean; reasons?: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const REF = new Set(REFERENCE_APPS.map(norm));
const V01 = new Set(V01_FINALISTS.map(norm));

export function cohortOf(p: Pick<ProjectLite, 'name' | 'source'>): Cohort | null {
  const n = norm(p.name);
  if (V01.has(n) || p.source === 'vibeathon01') return 'vibeathon01';
  if (REF.has(n)) return 'reference';
  if (p.source === 'base') return 'hackathon';
  if (p.source === 'vibestarter') return 'vibestarter';
  return null; // community entries are not part of the study
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
}

/** First night of the window of `days` nights that ends at `latest` (inclusive). */
export function windowStart(latest: string, days: number): string {
  const d = utc(latest);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return ymd(d);
}

/** One row per night; if both an observed and a reconstructed row exist the observed one wins. */
export function dedupeNights(nights: NightLite[]): NightLite[] {
  const by = new Map<string, NightLite>();
  for (const n of nights) {
    const cur = by.get(n.night);
    if (!cur || (n.observed && !cur.observed)) by.set(n.night, n);
  }
  return [...by.values()].sort((a, b) => a.night.localeCompare(b.night));
}

const isActivity = (s: string) => s === 'shipped' || s === 'building';

interface WindowMetrics {
  nights: number;
  unavailable: number;
  active: boolean | null;
  shipped: boolean | null;
}

/** `unavailable` rows are not observations: they never count as coverage (and so never as quiet). */
function windowMetrics(nights: NightLite[], from: string): WindowMetrics {
  const all = nights.filter((n) => n.night >= from);
  const w = all.filter((n) => n.status !== 'unavailable');
  const unavailable = all.length - w.length;
  if (!w.length) return { nights: 0, unavailable, active: null, shipped: null };
  return { nights: w.length, unavailable, active: w.some((n) => isActivity(n.status)), shipped: w.some((n) => n.status === 'shipped') };
}

/** 'history' = full 30-night window; 'partial' = some but < MIN_FULL_NIGHTS_30 nights; 'none' = nothing. */
export type Coverage = 'history' | 'partial' | 'none';
const coverageOf = (nights30: number): Coverage => (nights30 >= MIN_FULL_NIGHTS_30 ? 'history' : nights30 > 0 ? 'partial' : 'none');

export interface ProjectMetrics {
  coverage: Coverage;
  /** null = unknown (no or partial coverage), never false */
  active30: boolean | null;
  shipped30: boolean | null;
  active90: boolean | null;
  shipped90: boolean | null;
  /** non-unavailable nights in the last 30 / 90 */
  nights30: number;
  nights90: number;
  unavailable30: number;
  lastActivity: string | null;
  daysSinceActivity: number | null;
}

export function projectMetrics(rawNights: NightLite[], latest: string): ProjectMetrics {
  const nights = dedupeNights(rawNights);
  const w30 = windowMetrics(nights, windowStart(latest, 30));
  const w90 = windowMetrics(nights, windowStart(latest, 90));
  const act = nights.filter((n) => isActivity(n.status));
  const lastActivity = act.length ? act[act.length - 1].night : null;
  const coverage = coverageOf(w30.nights);
  const full = coverage === 'history';
  return {
    coverage,
    // a partial window is unknown, not quiet: no 30-night claim is made from it
    active30: full ? w30.active : null, shipped30: full ? w30.shipped : null,
    active90: w90.active, shipped90: w90.shipped,
    nights30: w30.nights, nights90: w90.nights, unavailable30: w30.unavailable,
    lastActivity, daysSinceActivity: lastActivity ? daysBetween(lastActivity, latest) : null,
  };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface FieldSummary {
  n: number;
  /** projects with a full 30-night window (>= MIN_FULL_NIGHTS_30 non-unavailable nights); all 30-night counts use only these */
  withHistory: number;
  /** projects with some but too few nights in the last 30: excluded from every 30-night count */
  partialWindow: number;
  active30: number;
  shipped30: number;
  /** withHistory - active30: full window and no detected commit or deploy. Unknown / partial projects are not counted. */
  quiet30: number;
  /** `unavailable` nights in the last 30 across the cohort (never counted as coverage) */
  unavailableNights30: number;
  /**
   * Median days since last activity among full-window projects that HAVE some activity in their (<=90 night) history.
   * Survivor-biased: only meaningful next to noActivityInHistory; never quote it alone.
   */
  medianDaysSinceActivityAmongActive: number | null;
  /** full-window projects with no activity at all in the available history (excluded from the median) */
  noActivityInHistory: number;
}

export function fieldSummary(rows: ProjectMetrics[]): FieldSummary {
  const h = rows.filter((r) => r.coverage === 'history');
  const active30 = h.filter((r) => r.active30).length;
  return {
    n: rows.length,
    withHistory: h.length,
    partialWindow: rows.filter((r) => r.coverage === 'partial').length,
    active30,
    shipped30: h.filter((r) => r.shipped30).length,
    quiet30: h.length - active30,
    unavailableNights30: rows.reduce((a, r) => a + r.unavailable30, 0),
    medianDaysSinceActivityAmongActive: median(h.filter((r) => r.daysSinceActivity != null).map((r) => r.daysSinceActivity as number)),
    noActivityInHistory: h.filter((r) => r.lastActivity == null).length,
  };
}

export interface CommitVsShip {
  /** projects with a full 30-night window */
  withHistory: number;
  /** projects with a partial window (excluded) */
  partialWindow: number;
  /** has building nights in the last 30 but zero shipped nights */
  commitsNoVerifiedShip: string[];
  /** nights shipped by a deploy (Wayback fingerprint change) with no code commits that night, per project */
  shipNightsWithoutCodeCommits: { name: string; nights: number }[];
  /** projects with shipped nights in the last 30 and no public repo (hasPublicRepo === false) */
  shipNoPublicRepo: string[];
}

/** Over each project's last 30 nights; full windows only. */
export function commitVsShip(byProject: { name: string; hasPublicRepo?: boolean; nights: NightLite[] }[], latest: string): CommitVsShip {
  const from = windowStart(latest, 30);
  const out: CommitVsShip = { withHistory: 0, partialWindow: 0, commitsNoVerifiedShip: [], shipNightsWithoutCodeCommits: [], shipNoPublicRepo: [] };
  for (const p of byProject) {
    const w = dedupeNights(p.nights).filter((n) => n.night >= from && n.status !== 'unavailable');
    if (w.length < MIN_FULL_NIGHTS_30) { if (w.length) out.partialWindow++; continue; }
    out.withHistory++;
    const shipped = w.filter((n) => n.status === 'shipped');
    if (!shipped.length && w.some((n) => n.status === 'building')) out.commitsNoVerifiedShip.push(p.name);
    const noCommit = shipped.filter((n) => !(n.reasons ?? []).includes('repo.code_commits')).length;
    if (noCommit) out.shipNightsWithoutCodeCommits.push({ name: p.name, nights: noCommit });
    if (shipped.length && p.hasPublicRepo === false) out.shipNoPublicRepo.push(p.name);
  }
  return out;
}

export interface Candidate { id: string; text: string; keys: string[]; values: Record<string, number> }

/** Dotted-key lookup in the merged results object; throws on a missing or non-scalar value. Arrays count as their length. */
export function lookup(data: unknown, key: string): string | number {
  let cur: unknown = data;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in (cur as object))) throw new Error(`unknown number key: ${key}`);
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === 'number' || typeof cur === 'string') return cur;
  if (Array.isArray(cur)) return cur.length;
  throw new Error(`number key is not a number: ${key}`);
}

/** Candidate sentences: templates with {dotted.key} placeholders, filled from `data` (errors on any unknown key). */
export function fillTemplate(id: string, template: string, data: unknown): Candidate {
  const keys: string[] = [];
  const values: Record<string, number> = {};
  const text = template.replace(/\{([\w.]+)\}/g, (_m, k: string) => {
    const v = lookup(data, k);
    keys.push(k);
    if (typeof v === 'number') values[k] = v;
    return String(v);
  });
  return { id, text, keys, values };
}

export const HEADLINE_TEMPLATES: { id: string; template: string }[] = [
  { id: 'hackathon-quiet', template: '{field.hackathon.quiet30} of {field.hackathon.withHistory} hackathon builds on Base showed no detected commit or deploy activity in the last 30 nights.' },
  { id: 'v01-still-lit', template: 'Of the {vibeathon01.summary.finalists} Vibeathon 01 finalists, {vibeathon01.summary.active30} showed detected commit or deploy activity in the last 30 nights, {vibeathon01.summary.withHistory} could be checked, and {vibeathon01.summary.unknown} have no usable public history ({vibeathon01.daysSinceResults} days after the results).' },
  { id: 'commit-no-ship', template: '{commitVsShip.commitsNoVerifiedShip} of {commitVsShip.withHistory} projects with a full 30-night window had commits but no detected deploy.' },
  { id: 'reference-vs-hackathon', template: '{field.reference.active30} of {field.reference.withHistory} big reference apps showed detected commit or deploy activity in the last 30 nights, against {field.hackathon.active30} of {field.hackathon.withHistory} hackathon builds.' },
];

/** Keys that must never be quoted on their own (survivor-biased). */
const STANDALONE_FORBIDDEN = /\.medianDaysSinceActivityAmongActive$/;

/** Replaces `<!-- num:key -->…<!-- /num -->` spans. Idempotent; throws on unknown keys and on the survivor-biased median. */
export function renderNumbers(md: string, data: unknown): string {
  return md.replace(/<!-- num:([\w.]+) -->([\s\S]*?)<!-- \/num -->/g, (_m, k: string) => {
    if (STANDALONE_FORBIDDEN.test(k)) throw new Error(`${k} is survivor-biased and may not be rendered on its own; quote noActivityInHistory alongside it in prose`);
    return `<!-- num:${k} -->${lookup(data, k)}<!-- /num -->`;
  });
}
