import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, NOW, TX, uidOf, until } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns, shifts } from '@/lib/db/schema';
import {
  createNightlyShift, getEvidence, getNights, getShift, insertNight,
} from '@/lib/db/queries';
import { dispatchShift } from '@/lib/shift/dispatch';
import { finalizeShift, maybeFinalizeStale } from '@/lib/shift/finalize';
import { runProject, runShiftProject, liveWindow } from '@/lib/shift/run';
import type { NightAttestation } from '@/lib/attest/eas';
import { keccak256, toBytes } from 'viem';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

type Mock = ReturnType<typeof vi.fn>;
const HASH = (i: number) => `0x${i.toString(16).padStart(64, 'e')}`;

async function shiftWithNights(n: number, night = '2026-11-06') {
  const { shift } = await createNightlyShift(db, { night, startedAt: NOW, planned: n });
  const projects = [];
  for (let i = 0; i < n; i++) {
    const p = await seedProject(db, `p${i}`);
    await insertNight(db, { projectId: p.id, night, status: 'shipped', observed: true, shiftId: shift.id, evidenceHash: HASH(i) });
    projects.push(p);
  }
  return { shift, projects };
}

describe('dispatchShift', () => {
  it('dispatch twice same night -> created false, no duplicate runs (Review Focus 4)', async () => {
    const a = await seedProject(db, 'alpha');
    const b = await seedProject(db, 'beta');
    await seedProject(db, 'gamma', { hidden: true });
    const trigger = vi.fn<(projectId: number, shiftId: number) => Promise<'accepted'>>(async () => 'accepted');
    const { deps } = makeDeps(db);
    const first = await dispatchShift(NOW, { ...deps, trigger });
    expect(first).toMatchObject({ planned: 2, created: true });
    // cron retry 40 minutes later: still the same night
    const second = await dispatchShift(new Date(NOW.getTime() + 40 * 60_000), { ...deps, trigger });
    expect(second).toEqual({ shiftId: first.shiftId, planned: 2, created: false });
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger.mock.calls.map((c) => c[0]).sort()).toEqual([a.id, b.id].sort());
    expect(trigger.mock.calls.every((c) => c[1] === first.shiftId)).toBe(true);
    expect(await db.select().from(shifts)).toHaveLength(1);
    expect((await getShift(db, first.shiftId))?.night).toBe('2026-11-06');
  });

  it('concurrent dispatches create one shift and fire each project once', async () => {
    await seedProject(db, 'alpha');
    await seedProject(db, 'beta');
    const trigger = vi.fn(async () => 'accepted' as const);
    const { deps } = makeDeps(db);
    const rs = await Promise.all([dispatchShift(NOW, { ...deps, trigger }), dispatchShift(NOW, { ...deps, trigger })]);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('fires at most 6 runs at once', async () => {
    for (let i = 0; i < 14; i++) await seedProject(db, `p${i}`);
    let inFlight = 0;
    let peak = 0;
    const trigger = vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 'accepted' as const;
    });
    const { deps } = makeDeps(db);
    await dispatchShift(NOW, { ...deps, trigger });
    expect(trigger).toHaveBeenCalledTimes(14);
    expect(peak).toBe(6);
  });

  it('refused triggers count as done, so the shift still finalizes when the rest finish', async () => {
    const a = await seedProject(db, 'alpha');
    const b = await seedProject(db, 'beta');
    const trigger = vi.fn(async (pid: number) => (pid === a.id ? 'refused' as const : 'accepted' as const));
    const { deps } = makeDeps(db);
    const d = await dispatchShift(NOW, { ...deps, trigger });
    expect((await getShift(db, d.shiftId))?.done).toBe(1);
    const r = await runShiftProject(d.shiftId, b.id, deps);
    expect(r.finalized).toBe(true);
    // the refused project got an `unavailable` night; both attested in one batch
    expect((await getNights(db, a.id))[0]).toMatchObject({ status: 'unavailable', shiftId: d.shiftId });
    expect(((deps.attestMany as Mock).mock.calls[0][0] as NightAttestation[]).length).toBe(2);
  });

  it('an empty watch list finalizes immediately', async () => {
    const trigger = vi.fn(async () => 'accepted' as const);
    const { deps } = makeDeps(db);
    const d = await dispatchShift(NOW, { ...deps, trigger });
    expect(d).toMatchObject({ planned: 0, created: true });
    expect((await getShift(db, d.shiftId))?.finishedAt).not.toBeNull();
  });
});

describe('finalizeShift', () => {
  it('finalize twice -> second attests 0 (each row exactly once)', async () => {
    const { shift, projects } = await shiftWithNights(3);
    const onFinalized = vi.fn(async () => {});
    const { deps } = makeDeps(db, { onFinalized });
    const r1 = await finalizeShift(shift.id, deps);
    expect(r1).toEqual({ attested: 3, txHash: TX });
    const r2 = await finalizeShift(shift.id, deps);
    expect(r2).toEqual({ attested: 0 });
    expect(deps.attestMany).toHaveBeenCalledTimes(1);
    const ns = (deps.attestMany as Mock).mock.calls[0][0] as NightAttestation[];
    expect(ns.map((n) => n.projectKey)).toEqual(projects.map((p) => keccak256(toBytes(p.slug))));
    expect(ns[0]).toMatchObject({ night: 20261106, kind: 0, status: 1, lit30: 1, evidenceHash: HASH(0), agentId: 0n });
    expect(ns[0].evidenceURI.endsWith(`/api/v1/evidence/${HASH(0)}`)).toBe(true);
    const uids = (await Promise.all(projects.map((p) => getNights(db, p.id)))).map((x) => x[0].attestationUid);
    expect(new Set(uids).size).toBe(3);
    expect((await getNights(db, projects[0].id))[0].attestTx).toBe(TX);
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', attestTx: TX });
    expect(onFinalized).toHaveBeenCalledTimes(1);
    expect(onFinalized).toHaveBeenCalledWith(shift.id);
  });

  it('concurrent finalizes attest each row exactly once', async () => {
    const { shift } = await shiftWithNights(4);
    const { deps } = makeDeps(db);
    const rs = await Promise.all([finalizeShift(shift.id, deps), finalizeShift(shift.id, deps), finalizeShift(shift.id, deps)]);
    expect(rs.reduce((n, r) => n + r.attested, 0)).toBe(4);
    const total = (deps.attestMany as Mock).mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);
    expect(total).toBe(4);
  });

  it('live run during finalize does not touch the nights row (Review Focus 4)', async () => {
    const { shift, projects } = await shiftWithNights(1);
    const p = projects[0];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      await gate;
      return { uids: ns.map((_, i) => uidOf(500 + i)), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestMany: attestMany as never });

    const fin = finalizeShift(shift.id, deps);
    await until(() => attestMany.mock.calls.length === 1); // rows claimed, tx in flight
    const before = await getNights(db, p.id);
    expect(before[0].attestClaimedAt).not.toBeNull();
    expect(before[0].attestationUid).toBeNull();

    const live = await runProject(p.id, 'live', await liveWindow(db, p.id, NOW), deps);
    expect(await getNights(db, p.id)).toEqual(before); // untouched while finalize holds the claim
    expect(live.liveRunId).toBeDefined();
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0 }); // nothing left to claim

    open();
    expect(await fin).toEqual({ attested: 1, txHash: TX });
    const after = await getNights(db, p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ attestationUid: uidOf(500), status: before[0].status, evidenceHash: before[0].evidenceHash });
    expect(attestMany).toHaveBeenCalledTimes(1);
    expect(((deps.attest as Mock).mock.calls[0][0] as NightAttestation).kind).toBe(1);
    expect(await db.select().from(liveRuns)).toHaveLength(1);
  });

  it('attest skipped -> claims released, shift attest_pending, a later finalize retries', async () => {
    const { shift, projects } = await shiftWithNights(2);
    const onFinalized = vi.fn(async () => {});
    const skip = makeDeps(db, { attestMany: vi.fn(async () => ({ skipped: 'gas_cap' as const })) as never, onFinalized }).deps;
    expect(await finalizeShift(shift.id, skip)).toEqual({ attested: 0, skipped: 'gas_cap' });
    const n0 = (await getNights(db, projects[0].id))[0];
    expect(n0).toMatchObject({ attestationUid: null, attestClaimedAt: null });
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:gas_cap' });
    expect(onFinalized).toHaveBeenCalledTimes(1); // briefings do not wait for the chain

    const { deps, clock } = makeDeps(db, { onFinalized });
    expect(await maybeFinalizeStale(deps)).toBe(0); // retried too soon
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(deps)).toBe(1);
    expect((await getNights(db, projects[1].id))[0].attestationUid).not.toBeNull();
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', notes: null });
    expect(onFinalized).toHaveBeenCalledTimes(1);
  });

  it('attests in batches of 20 and releases later batches after a skip', async () => {
    const { shift } = await shiftWithNights(45);
    let call = 0;
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      call++;
      if (call === 2) return { skipped: 'error' as const, error: 'reverted' };
      return { uids: ns.map((_, i) => uidOf(call * 100 + i)), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestMany: attestMany as never });
    const r = await finalizeShift(shift.id, deps);
    expect(attestMany.mock.calls.map((c) => c[0].length)).toEqual([20, 20]);
    expect(r).toEqual({ attested: 20, txHash: TX, skipped: 'error' });
    const s = await getShift(db, shift.id);
    expect(s).toMatchObject({ status: 'attest_pending', notes: 'skipped:error:reverted' });
    const r2 = await finalizeShift(shift.id, makeDeps(db).deps);
    expect(r2.attested).toBe(25);
  });

  it('lit30 counts reconstructed nights (observed wins on the same night)', async () => {
    const { shift, projects } = await shiftWithNights(1);
    const pid = projects[0].id;
    await insertNight(db, { projectId: pid, night: '2026-11-01', status: 'building', observed: false });
    await insertNight(db, { projectId: pid, night: '2026-11-02', status: 'shipped', observed: false });
    await insertNight(db, { projectId: pid, night: '2026-11-02', status: 'quiet', observed: true });
    await insertNight(db, { projectId: pid, night: '2026-09-01', status: 'shipped', observed: false });
    const { deps } = makeDeps(db);
    await finalizeShift(shift.id, deps);
    expect(((deps.attestMany as Mock).mock.calls[0][0] as NightAttestation[])[0].lit30).toBe(2);
  });

  it('a stale shift (> 45 min) is finalized by maybeFinalizeStale; missing projects get unavailable nights', async () => {
    const a = await seedProject(db, 'alpha');
    const b = await seedProject(db, 'beta');
    await seedProject(db, 'late', { createdAt: new Date(NOW.getTime() + 60_000) }); // added after dispatch
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 2 });
    const { deps, clock } = makeDeps(db);
    await runShiftProject(shift.id, a.id, deps); // beta never reports back

    clock.now = new Date(NOW.getTime() + 30 * 60_000);
    expect(await maybeFinalizeStale(deps)).toBe(0);
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(deps)).toBe(1);
    const nb = (await getNights(db, b.id))[0];
    expect(nb).toMatchObject({ night: '2026-11-06', status: 'unavailable', observed: true, shiftId: shift.id });
    expect(nb.attestationUid).not.toBeNull();
    const bundle = await getEvidence(db, nb.evidenceHash!);
    expect(bundle).toMatchObject({ project: 'beta', night: 20261106, kind: 'nightly', sources: { repo: null, liveapp: null, chain: null, vibestarter: null } });
    expect(await maybeFinalizeStale(deps)).toBe(0); // done now
    expect((await getShift(db, shift.id))?.status).toBe('attested');
    // a late run for beta cannot overwrite the filled night
    expect(await runShiftProject(shift.id, b.id, deps)).toMatchObject({ ok: false });
    expect((await getNights(db, b.id))[0]).toEqual(nb);
  });

  it('attestation disabled -> nights stay unattested, shift attest_pending, nothing thrown', async () => {
    const { shift } = await shiftWithNights(1);
    const { deps } = makeDeps(db, { attestMany: vi.fn(async () => ({ skipped: 'disabled' as const })) as never });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0, skipped: 'disabled' });
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');
  });
});
