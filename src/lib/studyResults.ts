import { z } from 'zod';
import {
  COHORTS, HEADLINE_TEMPLATES, daysBetween, fillTemplate, lookup, windowStart, type Candidate, type CommitVsShip, type Coverage, type FieldSummary,
} from '@/lib/study';
import { parseNightParam } from '@/lib/views/reasons';

/**
 * The shape of results/*.json (written by scripts/study.ts), shared by the README renderer and the /study page.
 * Namespaces are the ones the README spans and the headline keys use: field.*, vibeathon01.*, commitVsShip.*, headline.*.
 * Every check here is an invariant of scripts/study.ts, so a real run always passes and a drifted or hand-edited file
 * fails the build instead of rendering `undefined`.
 */
export const STUDY_FILES = {
  field: 'study-field.json',
  vibeathon01: 'study-vibeathon01.json',
  commitVsShip: 'commit-vs-ship.json',
  headline: 'headline.json',
} as const;
export type StudyNamespace = keyof typeof STUDY_FILES;

const day = z.string().refine((s) => parseNightParam(s) !== null, 'expected a YYYY-MM-DD calendar date');
const count = z.number().int().nonnegative();
const text = z.string().min(1);

const meta = z.object({ basis: text, asOf: day, latestNight: day, window30From: day, window90From: day });
type Meta = z.infer<typeof meta>;
const windowsAgree = (m: Meta) => m.window30From === windowStart(m.latestNight, 30) && m.window90From === windowStart(m.latestNight, 90);
const WINDOWS_MSG = 'window30From / window90From are not the 30 / 90 nights that end at latestNight';

const fieldSummary: z.ZodType<FieldSummary> = z
  .object({
    n: count, withHistory: count, partialWindow: count, active30: count, shipped30: count, quiet30: count,
    unavailableNights30: count, medianDaysSinceActivityAmongActive: z.number().nonnegative().nullable(), noActivityInHistory: count,
  })
  .refine((s) => s.withHistory + s.partialWindow <= s.n, 'withHistory + partialWindow exceeds n')
  .refine((s) => s.active30 <= s.withHistory && s.quiet30 === s.withHistory - s.active30, 'quiet30 must be withHistory - active30')
  .refine((s) => s.shipped30 <= s.active30, 'shipped30 exceeds active30')
  .refine((s) => s.noActivityInHistory <= s.quiet30, 'noActivityInHistory exceeds quiet30');

const fieldFile = meta
  .extend(Object.fromEntries(COHORTS.map((c) => [c, fieldSummary])) as Record<(typeof COHORTS)[number], typeof fieldSummary>)
  .refine(windowsAgree, WINDOWS_MSG);

const coverage = z.enum(['history', 'partial', 'none']) satisfies z.ZodType<Coverage>;
const finalist = z
  .object({
    name: text,
    liveUp: z.boolean().nullable(),
    liveUpSource: z.enum(['liveapp', 'probe']).nullable(),
    hasPublicRepo: z.boolean(),
    coverage,
    active30: z.boolean().nullable(),
    lastActivity: day.nullable(),
  })
  // unknown is never quiet: only a full window makes a 30-night claim
  .refine((p) => p.coverage === 'history' || p.active30 === null, 'active30 must be null (unknown) without a full window');

const v01File = meta
  .extend({
    resultsDate: day,
    daysSinceResults: count,
    liveUpBasis: text,
    perProject: z.array(finalist).min(1),
    summary: z.object({ finalists: count, liveUp: count, withHistory: count, active30: count, partialWindow: count, unknown: count }),
  })
  .refine(windowsAgree, WINDOWS_MSG)
  .refine((v) => v.daysSinceResults === daysBetween(v.resultsDate, v.latestNight), 'daysSinceResults is not resultsDate → latestNight')
  .refine((v) => {
    const p = v.perProject;
    const n = (f: (x: (typeof p)[number]) => boolean) => p.filter(f).length;
    const s = v.summary;
    return s.finalists === p.length && s.liveUp === n((x) => x.liveUp === true) && s.withHistory === n((x) => x.coverage === 'history')
      && s.active30 === n((x) => x.active30 === true) && s.partialWindow === n((x) => x.coverage === 'partial')
      && s.unknown === n((x) => x.coverage !== 'history');
  }, 'summary does not match perProject');

const commitVsShip: z.ZodType<CommitVsShip> = z.object({
  withHistory: count,
  partialWindow: count,
  commitsNoVerifiedShip: z.array(text),
  shipNightsWithoutCodeCommits: z.array(z.object({ name: text, nights: z.number().int().positive() })),
  shipNoPublicRepo: z.array(text),
});
const cvsFile = z
  .intersection(
    meta.extend({ definition: z.object({ commitsNoVerifiedShip: text, shipNightsWithoutCodeCommits: text, shipNoPublicRepo: text, windows: text }) }),
    commitVsShip,
  )
  .refine(windowsAgree, WINDOWS_MSG)
  .refine((c) => c.commitsNoVerifiedShip.length <= c.withHistory && c.shipNightsWithoutCodeCommits.length <= c.withHistory, 'more names than projects with history');

const candidate: z.ZodType<Candidate> = z.object({ id: text, text, keys: z.array(text), values: z.record(z.string(), z.number()) });
const headlineFile = meta.extend({ candidates: z.array(candidate) }).refine(windowsAgree, WINDOWS_MSG);

export type FieldFile = z.infer<typeof fieldFile>;
export type Vibeathon01File = z.infer<typeof v01File>;
export type CommitVsShipFile = z.infer<typeof cvsFile>;
export type HeadlineFile = z.infer<typeof headlineFile>;
export interface StudyResults { field: FieldFile; vibeathon01: Vibeathon01File; commitVsShip: CommitVsShipFile; headline: HeadlineFile }

const SCHEMAS = { field: fieldFile, vibeathon01: v01File, commitVsShip: cvsFile, headline: headlineFile } as const;
const fail = (ns: StudyNamespace, msg: string): never => {
  throw new Error(`results/${STUDY_FILES[ns]}: ${msg}`);
};

function parseOne<K extends StudyNamespace>(ns: K, raw: unknown): StudyResults[K] {
  const r = SCHEMAS[ns].safeParse(raw);
  if (!r.success) fail(ns, z.prettifyError(r.error).replace(/\n/g, ' '));
  return r.data as StudyResults[K];
}

/**
 * Validates the four results files together: each against its shape, all from the same study run (same basis, dates and
 * window), and every headline candidate present with the numbers the other files hold. Throws, naming the file.
 */
export function parseStudyResults(raw: Record<StudyNamespace, unknown>): StudyResults {
  const out = {
    field: parseOne('field', raw.field),
    vibeathon01: parseOne('vibeathon01', raw.vibeathon01),
    commitVsShip: parseOne('commitVsShip', raw.commitVsShip),
    headline: parseOne('headline', raw.headline),
  };
  for (const ns of ['vibeathon01', 'commitVsShip', 'headline'] as const) {
    for (const k of ['basis', 'asOf', 'latestNight', 'window30From'] as const) {
      if (out[ns][k] !== out.field[k]) fail(ns, `${k} ${out[ns][k]} differs from results/${STUDY_FILES.field} (${out.field[k]}): the files come from different study runs`);
    }
  }
  const data = { field: out.field, vibeathon01: out.vibeathon01, commitVsShip: out.commitVsShip };
  for (const { id, template } of HEADLINE_TEMPLATES) {
    const c = out.headline.candidates.find((x) => x.id === id);
    if (!c) return fail('headline', `missing candidate ${id}`);
    for (const [key, v] of Object.entries(c.values)) {
      let now: string | number;
      try {
        now = lookup(data, key);
      } catch {
        return fail('headline', `candidate ${id} quotes ${key}, which the results do not have`);
      }
      if (now !== v) fail('headline', `candidate ${id} is stale: ${key} is ${now} in the results, ${v} in the sentence`);
    }
    // the sentence itself is the template filled from these files, so no number in it can be edited by hand
    if (fillTemplate(id, template, data).text !== c.text) fail('headline', `candidate ${id} does not match its template filled from the results; rerun scripts/study.ts`);
  }
  return out;
}
