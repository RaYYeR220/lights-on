import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, stubAdapters, NOW } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { trancheEvents } from '@/lib/db/schema';
import {
  createNightlyShift, getOpenTranches, getTranches, saveEvidence, upsertTrancheEvents,
} from '@/lib/db/queries';
import { runProject } from '@/lib/shift/run';
import { nightlyWindow, shiftStartFor } from '@/lib/shift/night';
import { buildBriefing, gatherBriefingProjects } from '@/lib/notify/briefing';
import { getProject } from '@/lib/mcp/tools';
import type { Adapters } from '@/lib/shift/deps';
import type { EvidenceBundle, TrancheFact, VibestarterFacts } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

const WINDOW = nightlyWindow(shiftStartFor(NOW));
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Corvo Edge, 13 Nov style: kickstart and T1 paid, T2 requested with its challenge window still open. */
const SCHEDULE: TrancheFact[] = [
  { index: 0, status: 'PAID', requestedAt: null, windowEndsAt: null, amountPaidWei: '1000' },
  { index: 1, status: 'PAID', requestedAt: iso(NOW.getTime() - 200 * H), windowEndsAt: iso(NOW.getTime() - 130 * H), amountPaidWei: '2000' },
  { index: 2, status: 'REQUESTED', requestedAt: iso(NOW.getTime() - 20 * H), windowEndsAt: iso(NOW.getTime() + 30 * H), amountPaidWei: null },
];
const facts = (tranches: TrancheFact[]): VibestarterFacts => ({
  campaignId: 'camp1', raiseStatus: 'FUNDED', tranches, openWindow: tranches.find((t) => t.index === 2) ?? null,
  founderUpdates: [], reportedActivity: [],
});
const vibestarter = (tranches: TrancheFact[], ok = true) =>
  vi.fn(async () => ({ source: 'vibestarter', tier: 'verified', ok, facts: ok ? facts(tranches) : null })) as unknown as Adapters['vibestarter'];

describe('tranche_events from the shift run', () => {
  it('a nightly run with an open window writes tranche_events, and the briefing says when it closes', async () => {
    const p = await seedProject(db, 'corvo-edge', { name: 'Corvo Edge' });
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const { deps } = makeDeps(db, { adapters: stubAdapters({ vibestarter: vibestarter(SCHEDULE) }) });
    await runProject(p.id, 'nightly', WINDOW, deps, undefined, { shiftId: shift.id });

    const rows = await db.select().from(trancheEvents);
    expect(rows.map((r) => [r.trancheIndex, r.windowEndsAt?.toISOString() ?? null, r.amountWei])).toEqual([
      [0, null, '1000'], [1, SCHEDULE[1].windowEndsAt, '2000'], [2, SCHEDULE[2].windowEndsAt, null],
    ]);
    expect(rows[2].requestedAt?.toISOString()).toBe(SCHEDULE[2].requestedAt);

    const projects = await gatherBriefingProjects(db, [p.id], '2026-11-06', NOW);
    expect(projects[0].openWindow).toMatchObject({ index: 2, windowEndsAt: SCHEDULE[2].windowEndsAt });
    const b = await buildBriefing({ projects, date: 20261106 }, { now: () => NOW });
    expect(b.text).toContain('Upcoming: Corvo Edge — T2 window closes in 30 h');

    // the open API reads the same schedule
    const api = await getProject(db, 'corvo-edge', NOW) as { vibestarter: { tranches: unknown[]; openWindow: unknown } };
    expect(api.vibestarter.tranches).toHaveLength(3);
    expect(api.vibestarter.openWindow).toEqual({ index: 2, windowEndsAt: SCHEDULE[2].windowEndsAt });
  });

  it('a live run refreshes the schedule too; a failed vibestarter read leaves it untouched', async () => {
    const p = await seedProject(db, 'corvo-edge', { name: 'Corvo Edge' });
    const later = SCHEDULE.map((t) => (t.index === 2 ? { ...t, windowEndsAt: iso(NOW.getTime() + 50 * H) } : t));
    await upsertTrancheEvents(db, p.id, SCHEDULE);
    const live = makeDeps(db, { adapters: stubAdapters({ vibestarter: vibestarter(later) }) }).deps;
    await runProject(p.id, 'live', WINDOW, live);
    expect((await getTranches(db, p.id))[2].windowEndsAt?.toISOString()).toBe(later[2].windowEndsAt);

    const broken = makeDeps(db, { adapters: stubAdapters({ vibestarter: vibestarter([], false) }) }).deps;
    await runProject(p.id, 'live', WINDOW, { ...broken, now: () => new Date(NOW.getTime() + 6 * 60_000) });
    expect(await getTranches(db, p.id)).toHaveLength(3);
  });

  it('upsert keeps a request time and amount once seen; the window follows the latest read', async () => {
    const p = await seedProject(db, 'corvo-edge');
    await upsertTrancheEvents(db, p.id, SCHEDULE);
    await upsertTrancheEvents(db, p.id, SCHEDULE.map((t) => ({ ...t, requestedAt: null, amountPaidWei: null, windowEndsAt: t.index === 2 ? null : t.windowEndsAt })));
    const rows = await getTranches(db, p.id);
    expect(rows[1]).toMatchObject({ amountWei: '2000' });
    expect(rows[2].requestedAt?.toISOString()).toBe(SCHEDULE[2].requestedAt);
    expect(rows[2].windowEndsAt).toBeNull();
    expect(await upsertTrancheEvents(db, p.id, [])).toBe(0);
  });

  it('without tranche_events rows the readers fall back to the latest vibestarter evidence', async () => {
    const p = await seedProject(db, 'corvo-edge', { name: 'Corvo Edge' });
    const bundle = (night: number, tranches: TrancheFact[]): EvidenceBundle => ({
      v: 1, rulesVersion: 'r', project: 'corvo-edge', night, kind: 'nightly', window: WINDOW,
      sources: { repo: null, liveapp: null, chain: null, vibestarter: { source: 'vibestarter', tier: 'verified', ok: true, facts: facts(tranches) } },
    });
    await saveEvidence(db, '0xold', p.id, '2026-11-04', bundle(20261104, SCHEDULE.slice(0, 2)));
    await saveEvidence(db, '0xnew', p.id, '2026-11-05', bundle(20261105, SCHEDULE));
    const open = await getOpenTranches(db, [p.id], NOW);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ projectId: p.id, trancheIndex: 2, alerted: false });
    expect(open[0].windowEndsAt?.toISOString()).toBe(SCHEDULE[2].windowEndsAt);
    expect((await getTranches(db, p.id)).map((t) => t.trancheIndex)).toEqual([0, 1, 2]);
    // once the shift has written rows, those win
    await upsertTrancheEvents(db, p.id, SCHEDULE.slice(0, 2));
    expect(await getOpenTranches(db, [p.id], NOW)).toEqual([]);
  });

  it('the evidence fallback only runs for projects with a Vibestarter campaign', async () => {
    const other = await seedProject(db, 'plain-app', { vibestarter: null });
    const b: EvidenceBundle = {
      v: 1, rulesVersion: 'r', project: 'plain-app', night: 20261105, kind: 'nightly', window: WINDOW,
      sources: { repo: null, liveapp: null, chain: null, vibestarter: { source: 'vibestarter', tier: 'verified', ok: true, facts: facts(SCHEDULE) } },
    };
    await saveEvidence(db, '0xplain', other.id, '2026-11-05', b);
    expect(await getTranches(db, other.id)).toEqual([]);
    expect(await getOpenTranches(db, [other.id], NOW)).toEqual([]);
  });
});
