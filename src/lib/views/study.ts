import seed from '../../../data/seed-projects.json';
import fieldJson from '../../../results/study-field.json';
import v01Json from '../../../results/study-vibeathon01.json';
import cvsJson from '../../../results/commit-vs-ship.json';
import headlineJson from '../../../results/headline.json';
import { buildSeedProjects, type SeedFile } from '@/lib/backfill/seed';
import { REFERENCE_APPS, daysBetween, type Cohort, type Coverage } from '@/lib/study';
import { parseStudyResults, type StudyResults } from '@/lib/studyResults';
import { nightLabel, parseNightParam } from '@/lib/views/reasons';

/**
 * View model of the /study page, built from results/*.json only: every count, date and window, and every sentence that
 * carries one, comes from the files (validated by parseStudyResults). The page adds words, never numbers.
 */

export type StudyWindow = 'shipped' | 'building' | 'quiet';
export type YesNo = 'yes' | 'no' | 'unknown';

export interface StudyLink { name: string; href: string | null }

export interface CohortView {
  id: Cohort;
  label: string;
  hint: string | null;
  n: number;
  withHistory: number;
  active30: number;
  shipped30: number;
  /** projects in the cohort without a usable 30-night window: not drawn, and never counted as quiet */
  withoutHistory: number;
  /** one per project with history: shipped first, then commits only, then quiet */
  windows: StudyWindow[];
  /** "3 of 33 active in the last 30 nights" */
  count: string;
  /** "6 shipped · 2 commits only · 0 quiet" */
  detail: string;
  ariaLabel: string;
}

export interface FinalistRow extends StudyLink {
  liveUp: YesNo;
  publicRepo: 'yes' | 'no';
  coverage: string;
  active30: YesNo;
  /** YYYY-MM-DD or null */
  lastActivity: string | null;
  lastActivityText: string;
}

export interface StudyView {
  basis: string;
  asOf: string;
  asOfText: string;
  latestNight: string;
  latestNightText: string;
  window30From: string;
  window30FromText: string;
  /** nights in the window, window30From → latestNight inclusive */
  windowNights: number;
  headline: string;
  contrast: string;
  cohorts: CohortView[];
  v01: { heading: string; sentence: string; summary: string; liveUpBasis: string; rows: FinalistRow[] };
  cvs: {
    commits: { heading: string; caption: string; items: StudyLink[] };
    ships: { heading: string; caption: string; items: (StudyLink & { nights: number; nightsText: string })[] };
    why: string;
  };
  method: { basis: string; windows: string; command: string; sourceUrl: string; observed: string };
}

export const STUDY_SOURCE_URL = 'https://github.com/RaYYeR220/lights-on/blob/main/scripts/study.ts';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Watched projects by name, with the slugs scripts/seed.ts gives them (static: no database read at request time). */
export function seedSlugs(file: SeedFile): Map<string, string> {
  return new Map(buildSeedProjects(file, []).drafts.map((d) => [norm(d.name), d.slug]));
}
const SEED_SLUGS = seedSlugs(seed as unknown as SeedFile);

const dayText = (iso: string) => nightLabel(parseNightParam(iso)!, true);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const yesNo = (b: boolean | null): YesNo => (b === null ? 'unknown' : b ? 'yes' : 'no');

const COHORT_ORDER: { id: Cohort; label: string }[] = [
  { id: 'hackathon', label: 'Hackathon builds on Base' },
  { id: 'reference', label: 'Reference apps' },
  { id: 'vibestarter', label: 'Vibestarter raises' },
  { id: 'vibeathon01', label: 'Vibeathon 01 finalists with history' },
];

const COVERAGE_TEXT: Record<Coverage, string> = { history: 'full window', partial: 'partial window', none: 'no public history' };

function candidate(r: StudyResults, id: string): string {
  return r.headline.candidates.find((c) => c.id === id)!.text; // presence is checked by parseStudyResults
}

export function studyView(field: unknown, v01: unknown, cvs: unknown, headline: unknown, slugs: ReadonlyMap<string, string> = SEED_SLUGS): StudyView {
  const r = parseStudyResults({ field, vibeathon01: v01, commitVsShip: cvs, headline });
  const f = r.field;
  const windowNights = daysBetween(f.window30From, f.latestNight) + 1;
  const link = (name: string): StudyLink => {
    const slug = slugs.get(norm(name));
    return { name, href: slug ? `/p/${slug}` : null };
  };

  const cohorts = COHORT_ORDER.map(({ id, label }): CohortView => {
    const s = f[id];
    const building = s.active30 - s.shipped30;
    const withoutHistory = s.n - s.withHistory;
    const count = `${s.active30} of ${s.withHistory} active in the last ${windowNights} nights`;
    const detail = `${s.shipped30} shipped · ${building} commits only · ${s.quiet30} quiet`;
    const hint =
      id === 'reference'
        ? `${REFERENCE_APPS.slice(0, 3).join(', ')} and others`
        : withoutHistory > 0
          ? `${withoutHistory} of ${s.n} have no usable public history and are not drawn`
          : null;
    return {
      id, label, hint, n: s.n, withHistory: s.withHistory, active30: s.active30, shipped30: s.shipped30, withoutHistory,
      windows: [
        ...Array<StudyWindow>(s.shipped30).fill('shipped'),
        ...Array<StudyWindow>(building).fill('building'),
        ...Array<StudyWindow>(s.quiet30).fill('quiet'),
      ],
      count,
      detail,
      ariaLabel: `${label}: ${count} (${detail})`,
    };
  });

  const v = r.vibeathon01;
  const rows = v.perProject.map((p): FinalistRow => ({
    ...link(p.name),
    liveUp: yesNo(p.liveUp),
    publicRepo: p.hasPublicRepo ? 'yes' : 'no',
    coverage: COVERAGE_TEXT[p.coverage],
    active30: yesNo(p.active30),
    lastActivity: p.lastActivity,
    lastActivityText: p.lastActivity ? dayText(p.lastActivity) : p.coverage === 'none' ? 'unknown' : 'none seen',
  }));

  const c = r.commitVsShip;
  return {
    basis: f.basis,
    asOf: f.asOf,
    asOfText: dayText(f.asOf),
    latestNight: f.latestNight,
    latestNightText: dayText(f.latestNight),
    window30From: f.window30From,
    window30FromText: dayText(f.window30From),
    windowNights,
    headline: candidate(r, 'hackathon-quiet'),
    contrast: candidate(r, 'reference-vs-hackathon'),
    cohorts,
    v01: {
      heading: `Vibeathon 01, ${v.daysSinceResults} days later`,
      sentence: candidate(r, 'v01-still-lit'),
      summary: `${v.summary.liveUp} of ${v.summary.finalists} live apps still answer`,
      liveUpBasis: v.liveUpBasis,
      rows,
    },
    cvs: {
      commits: { heading: candidate(r, 'commit-no-ship'), caption: c.definition.commitsNoVerifiedShip, items: c.commitsNoVerifiedShip.map(link) },
      ships: {
        heading: `${plural(c.shipNightsWithoutCodeCommits.length, 'project', 'projects')} shipped on nights with no code commits`,
        caption: c.definition.shipNightsWithoutCodeCommits,
        items: c.shipNightsWithoutCodeCommits.map((x) => ({ ...link(x.name), nights: x.nights, nightsText: plural(x.nights, 'night', 'nights') })),
      },
      why: 'A commit graph would call the first group active and the second idle; Lights On checks what reached users.',
    },
    method: {
      basis: f.basis,
      windows: c.definition.windows,
      command: 'pnpm tsx scripts/study.ts',
      sourceUrl: STUDY_SOURCE_URL,
      observed: `From ${f.asOf} on, nights are observed and attested on Base; the study is recomputed as observed nights accumulate.`,
    },
  };
}

let committed: StudyView | undefined;

/** The study as committed in results/ (imported at build time, so a malformed file fails the build). */
export function getStudyView(): StudyView {
  committed ??= studyView(fieldJson, v01Json, cvsJson, headlineJson);
  return committed;
}
