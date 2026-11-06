import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, stubAdapters, liveFacts, NOW, uidOf, TX } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns, snapshots } from '@/lib/db/schema';
import {
  createNightlyShift, getEvidence, getLastSnapshot, getNights, getShift, insertNight, saveSnapshot, DuplicateNight,
  bumpBudget, releaseBudget,
} from '@/lib/db/queries';
import { runProject, runShiftProject, liveWindow } from '@/lib/shift/run';
import { nightlyWindow, shiftStartFor, nightNumber } from '@/lib/shift/night';
import { hashEvidence } from '@/lib/shift/evidence';
import { encodeNight, type NightAttestation } from '@/lib/attest/eas';
import type { Step } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

const WINDOW = nightlyWindow(shiftStartFor(NOW));

describe('night helpers', () => {
  it('shift start is the latest 05:00 UTC; window is the 24 h before it; night = yyyymmdd', () => {
    expect(shiftStartFor(new Date('2026-11-06T05:47:00Z')).toISOString()).toBe('2026-11-06T05:00:00.000Z');
    expect(shiftStartFor(new Date('2026-11-06T04:59:59Z')).toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(nightlyWindow(new Date('2026-11-06T05:00:00Z'))).toEqual({
      start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z',
    });
    expect(nightNumber(new Date('2026-11-06T05:00:00Z'))).toBe(20261106);
  });
});

describe('runProject (nightly)', () => {
  it('liveapp throws -> night still written, sources.liveapp.ok false', async () => {
    const p = await seedProject(db, 'alpha');
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const { deps } = makeDeps(db, {
      adapters: stubAdapters({ liveapp: vi.fn(async () => { throw new Error('boom https://rpc.secret.example/?key=abc'); }) }),
    });
    const r = await runProject(p.id, 'nightly', WINDOW, deps, undefined, { shiftId: shift.id });

    const [n] = await getNights(db, p.id);
    expect(n).toMatchObject({
      night: '2026-11-06', shiftId: shift.id, status: 'building', observed: true, evidenceHash: r.evidenceHash, aiOk: true,
    });
    expect(r).toMatchObject({ night: 20261106, status: 'building', nightId: n.id });
    const b = await getEvidence(db, r.evidenceHash);
    expect(b?.sources.liveapp).toMatchObject({ source: 'liveapp', ok: false, facts: null, error: 'error' });
    expect(b?.sources.repo?.ok).toBe(true);
    expect(JSON.stringify(b)).not.toContain('secret.example');
    expect(hashEvidence(b!)).toBe(r.evidenceHash); // stored bundle re-hashes to the stored hash
    expect((n.signals as { reasons: string[] }).reasons).toContain('source.liveapp.failed');
  });

  it('every adapter throws -> night still written as unavailable', async () => {
    const p = await seedProject(db, 'alpha');
    const boom = vi.fn(async () => { throw new Error('x'); });
    const { deps } = makeDeps(db, { adapters: stubAdapters({ liveapp: boom, repo: boom, chain: boom, vibestarter: boom }) as never });
    const r = await runProject(p.id, 'nightly', WINDOW, deps);
    expect(r.status).toBe('unavailable');
    expect((await getNights(db, p.id))[0].status).toBe('unavailable');
  });

  it('a project without repo/contracts/campaign gets null sources (not failures)', async () => {
    const p = await seedProject(db, 'bare', { repoHost: null, repo: null, contracts: null, vibestarter: null });
    const { deps } = makeDeps(db);
    const r = await runProject(p.id, 'nightly', WINDOW, deps);
    const b = await getEvidence(db, r.evidenceHash);
    expect(b?.sources).toMatchObject({ repo: null, chain: null, vibestarter: null });
    expect(b?.sources.liveapp?.ok).toBe(true);
    expect(r.status).toBe('quiet');
    expect(deps.adapters!.repo).not.toHaveBeenCalled();
  });

  it('passes deployer separately from app contracts and the campaign to vibestarter', async () => {
    const p = await seedProject(db, 'alpha');
    const { deps } = makeDeps(db);
    await runProject(p.id, 'nightly', WINDOW, deps);
    const chain = deps.adapters!.chain as ReturnType<typeof vi.fn>;
    expect(chain.mock.calls[0][0]).toEqual([{ chainId: 8453, address: '0xc0', role: 'app' }]);
    expect(chain.mock.calls[0][1]).toBe('0xd0');
    expect(chain.mock.calls[0][2]).toEqual(WINDOW);
    const vibe = deps.adapters!.vibestarter as ReturnType<typeof vi.fn>;
    expect(vibe.mock.calls[0].slice(0, 3)).toEqual(['camp1', '0xe0', WINDOW]);
  });

  it('saves liveapp (facts + text) and repo (headSha + etag) snapshots and feeds them back next night', async () => {
    const p = await seedProject(db, 'alpha');
    const { deps, clock } = makeDeps(db);
    await runProject(p.id, 'nightly', WINDOW, deps);
    const live = await getLastSnapshot(db, p.id, 'liveapp');
    expect(live?.fingerprint).toBe('fp2');
    expect(live?.data).toEqual({ facts: liveFacts(), text: 'Hello. New pricing.' });
    expect((await getLastSnapshot(db, p.id, 'repo'))?.data).toEqual({ headSha: 'head2', etag: 'etag2' });

    clock.now = new Date('2026-11-07T05:03:00Z');
    const { deps: deps2 } = makeDeps(db, { now: () => clock.now });
    await runProject(p.id, 'nightly', nightlyWindow(shiftStartFor(clock.now)), deps2);
    const la = (deps2.adapters!.liveapp as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(la[0]).toBe('https://alpha.example');
    expect(la[1]).toEqual(liveFacts());
    expect(la[2]).toMatchObject({ prevText: 'Hello. New pricing.' });
    const rp = (deps2.adapters!.repo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rp[0]).toEqual({ host: 'github', repo: 'o/alpha', branch: undefined });
    expect(rp[2]).toBe('head2');
    expect(rp[3]).toMatchObject({ prevEtag: 'etag2' });
  });

  it('does not overwrite a liveapp snapshot with a down observation', async () => {
    const p = await seedProject(db, 'alpha');
    await saveSnapshot(db, { projectId: p.id, adapter: 'liveapp', fingerprint: 'fp1', data: { facts: liveFacts({ deployFingerprint: 'fp1' }), text: 'old' } });
    const down = vi.fn(async () => ({
      result: { source: 'liveapp', tier: 'verified', ok: true, facts: liveFacts({ up: false, httpStatus: 503, deployFingerprint: null, textHash: null, textDelta: null }) },
      text: null,
    }));
    const { deps } = makeDeps(db, { adapters: stubAdapters({ liveapp: down as never }) });
    await runProject(p.id, 'nightly', WINDOW, deps);
    expect((await getLastSnapshot(db, p.id, 'liveapp'))?.fingerprint).toBe('fp1');
  });

  it('a second run for the same project-night throws DuplicateNight and changes nothing', async () => {
    const p = await seedProject(db, 'alpha');
    const { deps } = makeDeps(db);
    await runProject(p.id, 'nightly', WINDOW, deps);
    const before = await getNights(db, p.id);
    const snaps = (await db.select().from(snapshots)).length;
    const other = makeDeps(db, { adapters: stubAdapters({ liveapp: vi.fn(async () => { throw new Error('x'); }) }) }).deps;
    await expect(runProject(p.id, 'nightly', WINDOW, other)).rejects.toBeInstanceOf(DuplicateNight);
    expect(await getNights(db, p.id)).toEqual(before);
    expect((await db.select().from(snapshots)).length).toBe(snaps);
  });

  it('emits steps for every stage', async () => {
    const p = await seedProject(db, 'alpha');
    await saveSnapshot(db, { projectId: p.id, adapter: 'liveapp', fingerprint: 'fp2', data: { facts: liveFacts(), text: 'Hello.' } });
    const { deps } = makeDeps(db);
    const steps: Step[] = [];
    await runProject(p.id, 'nightly', WINDOW, deps, (s) => steps.push(s));
    const done = steps.filter((s) => s.state !== 'start').map((s) => s.key);
    expect(done).toEqual(expect.arrayContaining(['load', 'repo', 'liveapp', 'chain', 'vibestarter', 'rules', 'explain', 'evidence']));
    expect(steps.find((s) => s.key === 'repo' && s.state === 'ok')?.detail).toBe('1 commit, 0 releases');
    expect(steps.find((s) => s.key === 'liveapp' && s.state === 'ok')?.detail).toBe('same deploy · 2 KB of text changed');
    expect(steps.some((s) => s.key === 'attest')).toBe(false);
  });
});

describe('runShiftProject', () => {
  it('the last finishing run finalizes the shift once; a duplicate run does not count', async () => {
    const a = await seedProject(db, 'alpha');
    const b = await seedProject(db, 'beta');
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 2 });
    const { deps } = makeDeps(db);
    expect(await runShiftProject(shift.id, a.id, deps)).toMatchObject({ ok: true, finalized: false });
    expect(await runShiftProject(shift.id, a.id, deps)).toMatchObject({ ok: false, code: 'duplicate' });
    expect((await getShift(db, shift.id))?.done).toBe(1);
    expect(deps.attestMany).not.toHaveBeenCalled();
    expect(await runShiftProject(shift.id, b.id, deps)).toMatchObject({ ok: true, finalized: true });
    expect(deps.attestMany).toHaveBeenCalledTimes(1);
    expect((deps.attestMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
    const s = await getShift(db, shift.id);
    expect(s).toMatchObject({ done: 2, status: 'attested', attestTx: TX });
  });

  it('a run that crashes (db write fails once) still counts as done; finalize fills its night as unavailable', async () => {
    const a = await seedProject(db, 'alpha');
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    let failed = false;
    const flaky = Object.create(db) as Db;
    flaky.insert = ((t: never) => {
      if (!failed) { failed = true; throw new Error('db down'); }
      return db.insert(t);
    }) as Db['insert'];
    const { deps } = makeDeps(flaky);
    expect(await runShiftProject(shift.id, a.id, deps)).toMatchObject({ ok: false, code: 'run_failed', finalized: true });
    expect((await getShift(db, shift.id))?.done).toBe(1);
    const nights = await getNights(db, a.id);
    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({ night: '2026-11-06', status: 'unavailable', shiftId: shift.id, attestationUid: uidOf(1) });
  });

  it('unknown shift -> fixed code, nothing written', async () => {
    const a = await seedProject(db, 'alpha');
    const { deps } = makeDeps(db);
    expect(await runShiftProject(999, a.id, deps)).toEqual({ ok: false, code: 'shift_not_found' });
    expect(await getNights(db, a.id)).toHaveLength(0);
  });
});

describe('runProject (live)', () => {
  it('attest skipped -> live run status done with attestation skipped, not failed', async () => {
    const p = await seedProject(db, 'alpha');
    const { deps } = makeDeps(db, { attest: vi.fn(async () => ({ skipped: 'gas_cap' as const })) as never });
    const steps: Step[] = [];
    const r = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps, (s) => steps.push(s));
    expect(r.attestation).toEqual({ skipped: 'gas_cap' });
    const [run] = await db.select().from(liveRuns).where(eq(liveRuns.id, r.liveRunId!));
    expect(run).toMatchObject({ status: 'done', attestationUid: null, tx: null, evidenceHash: r.evidenceHash });
    const last = steps.at(-1)!;
    expect(last).toMatchObject({ key: 'attest', state: 'warn', detail: 'skipped (daily gas cap)' });
    expect(run.steps.at(-1)).toEqual(last);
    expect(new Set(steps.map((s) => s.key))).toEqual(
      new Set(['load', 'repo', 'liveapp', 'chain', 'vibestarter', 'rules', 'explain', 'evidence', 'attest']),
    );
  });

  it('attests kind 1 with lit30 over stored nights (incl. reconstructed) and records uid + tx', async () => {
    const p = await seedProject(db, 'alpha');
    await insertNight(db, { projectId: p.id, night: '2026-11-04', status: 'shipped', observed: false });
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'building', observed: true });
    await insertNight(db, { projectId: p.id, night: '2026-10-01', status: 'shipped', observed: false }); // > 30 nights back
    const { deps } = makeDeps(db);
    const r = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps);
    const n = (deps.attest as ReturnType<typeof vi.fn>).mock.calls[0][0] as NightAttestation;
    expect(n).toMatchObject({ night: 20261106, kind: 1, status: 2, lit30: 2, evidenceHash: r.evidenceHash, agentId: 42n });
    expect(n.evidenceURI).toMatch(new RegExp(`/api/v1/evidence/${r.evidenceHash}$`));
    expect(() => encodeNight(n)).not.toThrow();
    const [run] = await db.select().from(liveRuns);
    expect(run).toMatchObject({ status: 'done', attestationUid: r.attestation && 'uid' in r.attestation ? r.attestation.uid : 'x', tx: TX });
    expect(await getEvidence(db, r.evidenceHash)).not.toBeNull();
  });

  it('writes no nights and no snapshots, but reads the last snapshots as prev', async () => {
    const p = await seedProject(db, 'alpha');
    await saveSnapshot(db, { projectId: p.id, adapter: 'liveapp', fingerprint: 'fp1', data: { facts: liveFacts({ deployFingerprint: 'fp1' }), text: 'old text' } });
    await saveSnapshot(db, { projectId: p.id, adapter: 'repo', fingerprint: 'head1', data: { headSha: 'head1', etag: 'e1' } });
    const { deps } = makeDeps(db);
    await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps);
    expect(await getNights(db, p.id)).toHaveLength(0);
    expect(await db.select().from(snapshots)).toHaveLength(2);
    const la = (deps.adapters!.liveapp as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(la[1]).toMatchObject({ deployFingerprint: 'fp1' });
    expect(la[2]).toMatchObject({ prevText: 'old text' });
    expect((deps.adapters!.repo as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('head1');
  });

  it('no watcher agentId -> live attestation disabled, attest never called', async () => {
    const p = await seedProject(db, 'alpha');
    for (const agentId of [undefined, 0n]) {
      const { deps } = makeDeps(db, { agentId });
      const steps: Step[] = [];
      const r = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps, (s) => steps.push(s));
      expect(r.attestation).toEqual({ skipped: 'disabled' });
      expect(deps.attest).not.toHaveBeenCalled();
      expect(steps.at(-1)).toMatchObject({ key: 'attest', state: 'warn', detail: 'skipped (attestation disabled)' });
    }
  });

  it('a broadcast but unconfirmed live attestation keeps its tx (done, no uid)', async () => {
    const p = await seedProject(db, 'alpha');
    const tx = `0x${'cd'.repeat(32)}`;
    const { deps } = makeDeps(db, { attest: vi.fn(async () => ({ skipped: 'error' as const, error: 'timeout', txHash: tx })) as never });
    const steps: Step[] = [];
    const r = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps, (s) => steps.push(s));
    expect(r.attestation).toEqual({ skipped: 'error', error: 'timeout', txHash: tx });
    const [run] = await db.select().from(liveRuns);
    expect(run).toMatchObject({ status: 'done', attestationUid: null, tx });
    expect(steps.at(-1)?.detail).toMatch(/^sent, not confirmed yet · tx 0xcdcdcdcd/);
  });

  it('refunds the unused LLM reservation after explain', async () => {
    const p = await seedProject(db, 'alpha');
    const day = '2026-11-06';
    const explain = vi.fn(async (_b: unknown, _d: unknown, x: { budget: (n: number) => Promise<boolean> }) => {
      await x.budget(1000);
      await x.budget(500);
      return { aiOk: true, summary: 'Code changes landed.', notable: [], aiSubstance: null, model: 'm', tokens: 300 };
    });
    const { deps } = makeDeps(db, {
      explain: explain as never,
      budget: (f, n) => bumpBudget(db, day, f, n, 1e9),
      release: (f, n) => releaseBudget(db, day, f, n),
    });
    await runProject(p.id, 'nightly', WINDOW, deps);
    const r = await db.execute(`select llm_tokens::text as t from budget where day='${day}'` as never);
    expect((r.rows[0] as { t: string }).t).toBe('300');
  });

  it('facts of an unexpected shape fail that source only (the step detail is computed inside the guard)', async () => {
    const p = await seedProject(db, 'alpha');
    const odd = vi.fn(async () => ({ result: { source: 'repo', tier: 'verified', ok: true, facts: { host: 'github' } }, etag: null }));
    const { deps } = makeDeps(db, { adapters: stubAdapters({ repo: odd as never }) });
    const steps: Step[] = [];
    const r = await runProject(p.id, 'nightly', WINDOW, deps, (s) => steps.push(s));
    expect(steps.find((s) => s.key === 'repo' && s.state !== 'start')).toMatchObject({ state: 'fail' });
    expect((await getEvidence(db, r.evidenceHash))?.sources.repo).toMatchObject({ ok: false, facts: null });
    expect((await getNights(db, p.id))).toHaveLength(1);
  });

  it('live window starts at the last nightly shift start, else 24 h back', async () => {
    const p = await seedProject(db, 'alpha');
    const now = new Date('2026-11-06T14:30:00Z');
    expect(await liveWindow(db, p.id, now)).toEqual({ start: '2026-11-05T14:30:00.000Z', end: '2026-11-06T14:30:00.000Z' });
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: new Date('2026-11-06T05:41:00Z'), planned: 1 });
    await insertNight(db, { projectId: p.id, night: '2026-11-06', status: 'quiet', observed: true, shiftId: shift.id });
    expect(await liveWindow(db, p.id, now)).toEqual({ start: '2026-11-06T05:00:00.000Z', end: '2026-11-06T14:30:00.000Z' });
  });

  it('a reserved live run row is reused; a crash marks it failed', async () => {
    const p = await seedProject(db, 'alpha');
    const [row] = await db.insert(liveRuns).values({ projectId: p.id, requesterIpHash: 'h', startedAt: NOW }).returning();
    const { deps } = makeDeps(db, { explain: vi.fn(async () => ({ aiOk: false, summary: null, notable: [], aiSubstance: null, model: null, tokens: 0 })) as never });
    const r = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps, undefined, { liveRunId: row.id });
    expect(r.liveRunId).toBe(row.id);
    expect(await db.select().from(liveRuns)).toHaveLength(1);

    // an attest that throws is contained: still done, attestation skipped
    const [row2] = await db.insert(liveRuns).values({ projectId: p.id, requesterIpHash: 'h', startedAt: NOW }).returning();
    const throwing = makeDeps(db, { attest: vi.fn(async () => { throw new Error('x'); }) as never }).deps;
    const r2 = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), throwing, undefined, { liveRunId: row2.id });
    expect(r2.attestation).toEqual({ skipped: 'error', error: 'error' });

    // a storage failure fails the run, records the failing step, and rethrows
    const [row3] = await db.insert(liveRuns).values({ projectId: p.id, requesterIpHash: 'h', startedAt: NOW }).returning();
    const flaky = Object.create(db) as Db;
    flaky.insert = (() => { throw new Error('db down'); }) as never;
    await expect(runProject(p.id, 'live', await liveWindow(db, p.id, NOW), makeDeps(flaky).deps, undefined, { liveRunId: row3.id })).rejects.toThrow();
    const [failed] = await db.select().from(liveRuns).where(eq(liveRuns.id, row3.id));
    expect(failed.status).toBe('failed');
    expect(failed.steps.at(-1)).toMatchObject({ key: 'evidence', state: 'fail', detail: 'error' });
  });
});
