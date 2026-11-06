import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { getNights, getProjectBySlug } from '@/lib/db/queries';
import { evidence, nights, type NightRow, type ProjectRow } from '@/lib/db/schema';
import { sanitizeSummary } from '@/lib/shift/explain';
import { computeRecord } from '@/lib/shift/rules';
import { nightDate, nightNumber, nightOf, shiftStartFor } from '@/lib/shift/night';
import type { Status, VibestarterFacts } from '@/lib/types';
import { nightsEndingAt, TOWER_NIGHTS } from './tower';

/** One night of the project's strip: the observed row when there is one, else the reconstructed one, else nothing. */
export interface StripNight {
  night: number;
  status: Status | null;
  observed: boolean;
  /** A reconstructed row exists for this night too (shown in the drawer). */
  alsoReconstructed: boolean;
  /** AI explanation (sanitized); null when no model wrote one. */
  summary: string | null;
  /** A deterministic no-AI summary, labelled as such. */
  templateSummary: string | null;
  notable: string[];
  reasons: string[];
  evidenceHash: string | null;
  attestationUid: string | null;
  attestTx: string | null;
  /** Reconstruction source ('git', 'wayback', 'git+wayback') and the Wayback capture note, when reconstructed. */
  reconstructedFrom: string | null;
  note: string | null;
}

export interface ProjectView {
  slug: string;
  name: string;
  tagline: string | null;
  source: ProjectRow['source'];
  liveUrl: string | null;
  repoUrl: string | null;
  repo: string | null;
  contracts: { chainId: number; address: string; role: string }[];
  token: { chainId: number; address: string; symbol: string } | null;
  vibestarter: { campaignId: string; escrow: string; founderWallet: string } | null;
  /** When the view was built (ms): the reference time for open windows. */
  generatedAt: number;
  lastNight: number;
  strip: StripNight[];
  status: Status | null;
  statusObserved: boolean;
  statusNight: number | null;
  streak: number;
  lit30: number;
  lastShip: number | null;
  reconstructedNights: number;
  /** Latest recorded Vibestarter facts (tranches, open challenge window) and the night they come from. */
  vibestarterFacts: { night: number; facts: VibestarterFacts } | null;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stripNight(night: number, obs: NightRow | undefined, rec: NightRow | undefined): StripNight {
  const row = obs ?? rec;
  const signals = isRec(row?.signals) ? row!.signals : {};
  const summary = row?.summary ? sanitizeSummary(row.summary) : null;
  return {
    night,
    status: row?.status ?? null,
    observed: Boolean(obs),
    alsoReconstructed: Boolean(obs && rec),
    summary: row?.aiModel ? summary : null,
    templateSummary: row && !row.aiModel ? summary : null,
    notable: asStrings(row?.notable).map((n) => sanitizeSummary(n)).filter((n): n is string => !!n).slice(0, 5),
    reasons: asStrings(signals.reasons),
    evidenceHash: row?.evidenceHash ?? null,
    attestationUid: obs?.attestationUid ?? null,
    attestTx: obs?.attestTx ?? null,
    reconstructedFrom: !obs && typeof signals.source === 'string' ? signals.source : null,
    note: !obs && typeof signals.note === 'string' ? signals.note : null,
  };
}

/** Everything /p/[slug] renders. Null for unknown or hidden projects. */
export async function getProjectView(db: Db, slug: string, opts: { now?: Date } = {}): Promise<ProjectView | null> {
  const p = await getProjectBySlug(db, slug);
  if (!p || p.hidden) return null;
  const now = opts.now ?? new Date();
  const lastNight = nightNumber(shiftStartFor(now));
  const window = nightsEndingAt(lastNight, TOWER_NIGHTS);
  const [rows, vsRows] = await Promise.all([
    getNights(db, p.id, { from: nightDate(window[0]), to: nightDate(lastNight) }),
    p.vibestarter
      ? db
          .select({ night: nights.night, facts: sql<unknown>`${evidence.bundle} #> '{sources,vibestarter,facts}'` })
          .from(nights)
          .innerJoin(evidence, eq(evidence.hash, nights.evidenceHash))
          .where(and(eq(nights.projectId, p.id), sql`jsonb_typeof(${evidence.bundle} #> '{sources,vibestarter,facts}') = 'object'`))
          .orderBy(desc(nights.night), desc(nights.observed))
          .limit(1)
      : Promise.resolve([] as { night: string; facts: unknown }[]),
  ]);

  const obs = new Map<number, NightRow>();
  const rec = new Map<number, NightRow>();
  for (const r of rows) (r.observed ? obs : rec).set(nightOf(r.night), r);
  const strip = window.map((n) => stripNight(n, obs.get(n), rec.get(n)));

  const latestObs = [...obs.keys()].sort((a, b) => b - a)[0];
  const latestRec = [...rec.keys()].sort((a, b) => b - a)[0];
  const statusNight = latestObs ?? latestRec ?? null;
  const statusRow = statusNight === null ? undefined : (obs.get(statusNight) ?? rec.get(statusNight));
  const record = computeRecord(
    strip.flatMap((s) => (s.status ? [{ night: s.night, status: s.status }] : [])),
    lastNight,
  );
  const vs = vsRows[0];
  const repoUrl = p.repo ? `${p.repoHost === 'gitlab' ? 'https://gitlab.com' : 'https://github.com'}/${p.repo}` : null;

  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    source: p.source,
    liveUrl: p.liveUrl,
    repoUrl,
    repo: p.repo,
    contracts: Array.isArray(p.contracts) ? p.contracts : [],
    token: p.token ?? null,
    vibestarter: p.vibestarter ?? null,
    generatedAt: now.getTime(),
    lastNight,
    strip,
    status: statusRow?.status ?? null,
    statusObserved: latestObs !== undefined,
    statusNight,
    streak: record.streak,
    lit30: record.lit30,
    lastShip: record.lastShip,
    reconstructedNights: strip.filter((s) => s.status && !s.observed).length,
    vibestarterFacts: vs && isRec(vs.facts) ? { night: nightOf(vs.night), facts: vs.facts as unknown as VibestarterFacts } : null,
  };
}
