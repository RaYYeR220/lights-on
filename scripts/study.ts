import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadEnv, ROOT } from './_backfill';
import {
  BASIS, COHORTS, HEADLINE_TEMPLATES, V01_RESULTS_DATE, cohortOf, commitVsShip, daysBetween, fieldSummary, fillTemplate,
  projectMetrics, windowStart, type Cohort, type NightLite, type ProjectMetrics,
} from '@/lib/study';

loadEnv();

const PROBE = path.resolve(ROOT, '../research/probe-2026-11-06.json');
const out = (name: string, v: unknown) => {
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', name), JSON.stringify(v, null, 2) + '\n');
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

type LiveUp = { up: boolean | null; source: 'liveapp' | 'probe' | null; at: string | null };

async function main() {
  const [{ getDb }, { projects, nights, evidence }] = await Promise.all([import('@/lib/db'), import('@/lib/db/schema')]);
  const db = await getDb();

  const projs = await db.select().from(projects).where(eq(projects.hidden, false));
  const rows = await db.select({
    projectId: nights.projectId, night: nights.night, status: nights.status, observed: nights.observed, signals: nights.signals,
  }).from(nights);
  const latest = rows.reduce((m, r) => (r.night > m ? r.night : m), '');
  if (!latest) throw new Error('no nights in the database');

  const byProject = new Map<number, NightLite[]>();
  for (const r of rows) {
    const reasons = (r.signals as { reasons?: string[] } | null)?.reasons ?? [];
    (byProject.get(r.projectId) ?? byProject.set(r.projectId, []).get(r.projectId)!).push({ night: r.night, status: r.status, observed: r.observed, reasons });
  }

  // liveUp: latest OBSERVED liveapp evidence if any, else the 2026-11-05 probe (labelled).
  const observedLive = new Map<number, { up: boolean; at: string }>();
  const obs = await db.select({ projectId: nights.projectId, night: nights.night, bundle: evidence.bundle })
    .from(nights).innerJoin(evidence, eq(evidence.hash, nights.evidenceHash)).where(and(eq(nights.observed, true), sql`${nights.evidenceHash} is not null`));
  for (const o of obs.sort((a, b) => a.night.localeCompare(b.night))) {
    const f = o.bundle.sources.liveapp?.facts;
    if (f) observedLive.set(o.projectId, { up: f.up, at: o.night });
  }
  const probe = JSON.parse(fs.readFileSync(PROBE, 'utf8')) as { probed_at: string; rows: { name: string; live_status: number | null }[] };
  const probeBy = new Map(probe.rows.map((r) => [norm(r.name), r]));
  const liveUpOf = (id: number, name: string): LiveUp => {
    const o = observedLive.get(id);
    if (o) return { up: o.up, source: 'liveapp', at: o.at };
    const p = probeBy.get(norm(name));
    if (!p) return { up: null, source: null, at: null };
    return { up: p.live_status != null && p.live_status >= 200 && p.live_status < 400, source: 'probe', at: probe.probed_at };
  };

  const table = projs.map((p) => {
    const cohort = cohortOf(p);
    return { id: p.id, slug: p.slug, name: p.name, source: p.source, cohort, hasPublicRepo: !!p.repo, liveUp: liveUpOf(p.id, p.name), ...projectMetrics(byProject.get(p.id) ?? [], latest) };
  }).filter((r) => r.cohort);
  fs.mkdirSync(path.join(ROOT, 'results', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'raw', 'study-projects.json'), JSON.stringify({ latest, table }, null, 2));

  const meta = { basis: BASIS, asOf: latest, latestNight: latest, window30From: windowStart(latest, 30), window90From: windowStart(latest, 90) };

  // field
  const field: Record<string, unknown> = { ...meta };
  for (const c of COHORTS) field[c] = fieldSummary(table.filter((r) => r.cohort === c) as ProjectMetrics[]);
  out('study-field.json', field);

  // vibeathon01
  const fin = table.filter((r) => r.cohort === 'vibeathon01');
  const missing = fin.filter((r) => !probeBy.has(norm(r.name)) && r.liveUp.source !== 'liveapp').map((r) => r.name);
  if (fin.length !== 10 || missing.length) throw new Error(`expected 10 finalists with liveUp evidence; got ${fin.length}, no probe row for: ${missing.join(', ') || '-'}`);
  const vibeathon01 = {
    ...meta,
    resultsDate: V01_RESULTS_DATE,
    daysSinceResults: daysBetween(V01_RESULTS_DATE, latest),
    liveUpBasis: `liveUp = HTTP probe of ${probe.probed_at} answered 2xx/3xx; says nothing about whether the app works or is maintained`,
    perProject: fin.map((r) => ({ name: r.name, liveUp: r.liveUp.up, liveUpSource: r.liveUp.source, hasPublicRepo: r.hasPublicRepo, coverage: r.coverage, active30: r.active30, lastActivity: r.lastActivity })),
    summary: {
      finalists: fin.length,
      liveUp: fin.filter((r) => r.liveUp.up === true).length,
      withHistory: fin.filter((r) => r.coverage === 'history').length,
      active30: fin.filter((r) => r.active30).length,
      partialWindow: fin.filter((r) => r.coverage === 'partial').length,
      unknown: fin.filter((r) => r.coverage !== 'history').length,
    },
  };
  out('study-vibeathon01.json', vibeathon01);

  // commit vs ship (all cohorts with history)
  const cvs = commitVsShip(table.map((r) => ({ name: r.name, hasPublicRepo: r.hasPublicRepo, nights: byProject.get(r.id) ?? [] })), latest);
  const commitVsShipJson = { ...meta, definition: {
    commitsNoVerifiedShip: 'has building nights in the last 30 but zero shipped nights: commits seen, no deploy detected',
    shipNightsWithoutCodeCommits: 'nights shipped by a deploy, release or contract deploy with no code commits that night (full 30-night windows only)',
    shipNoPublicRepo: 'projects with shipped nights in the last 30 whose hasPublicRepo is false',
    windows: 'only projects with >= 25 non-unavailable nights in the last 30 are counted; unavailable rows never count as coverage',
  }, ...cvs };
  out('commit-vs-ship.json', commitVsShipJson);

  // headline
  const data = { field, vibeathon01, commitVsShip: commitVsShipJson };
  out('headline.json', { ...meta, candidates: HEADLINE_TEMPLATES.map((t) => fillTemplate(t.id, t.template, data)) });

  console.log(JSON.stringify({ latest, field: Object.fromEntries(COHORTS.map((c) => [c, field[c]])), v01: vibeathon01.summary, cvs: { withHistory: cvs.withHistory, commitsNoVerifiedShip: cvs.commitsNoVerifiedShip.length, shipNightsWithoutCodeCommits: cvs.shipNightsWithoutCodeCommits.length, shipNoPublicRepo: cvs.shipNoPublicRepo.length, partialWindow: cvs.partialWindow } }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
