import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, NOW, TX, uidOf, until } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns, nights, shifts } from '@/lib/db/schema';
import {
  createNightlyShift, getEvidence, getNights, getShift, insertNight, listStaleShifts, updateShift,
  claimShiftNights, releaseNightClaims, markNightsBroadcast, setNightAttestations,
} from '@/lib/db/queries';
import { dispatchShift } from '@/lib/shift/dispatch';
import { finalizeShift, maybeFinalizeStale } from '@/lib/shift/finalize';
import { runProject, runShiftProject, liveWindow } from '@/lib/shift/run';
import { attestMany as realAttestMany, type AttestDeps, type NightAttestation } from '@/lib/attest/eas';
import type { ShiftDeps } from '@/lib/shift/deps';
import { keccak256, toBytes, type Hex } from 'viem';
import { asc, eq } from 'drizzle-orm';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

type Mock = ReturnType<typeof vi.fn>;
const HASH = (i: number) => `0x${i.toString(16).padStart(64, 'e')}`;
const TX2 = `0x${'cd'.repeat(32)}` as Hex;
const SENDER = '0x00000000000000000000000000000000000000aa' as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const nightsOf = (shiftId: number) => db.select().from(nights).where(eq(nights.shiftId, shiftId)).orderBy(asc(nights.id));

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
    expect(ns[0]).toMatchObject({ night: 20261106, kind: 0, status: 1, lit30: 1, evidenceHash: HASH(0), agentId: 42n });
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

  it('attests in batches of 20; a broadcast batch with an unknown outcome stays claimed, later batches are released', async () => {
    const { shift } = await shiftWithNights(45);
    let call = 0;
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      call++;
      if (call === 2) return { skipped: 'error' as const, error: 'timeout', txHash: TX2 }; // sent, receipt wait failed
      return { uids: ns.map((_, i) => uidOf(call * 100 + i)), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestMany: attestMany as never });
    const r = await finalizeShift(shift.id, deps);
    expect(attestMany.mock.calls.map((c) => c[0].length)).toEqual([20, 20]);
    expect(r).toEqual({ attested: 20, txHash: TX, skipped: 'unconfirmed' });
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'unconfirmed:timeout' });
    const rows = await nightsOf(shift.id);
    const batch2 = rows.slice(20, 40);
    expect(batch2.every((n) => n.attestClaimedAt !== null && n.attestTx === TX2 && n.attestationUid === null)).toBe(true);
    expect(rows.slice(40).every((n) => n.attestClaimedAt === null && n.attestTx === null)).toBe(true);

    // next pass: receipt not there yet -> batch 2 untouched; only the 5 never-sent rows go out
    const pending = vi.fn(async () => ({ status: 'pending' as const }));
    const d2 = makeDeps(db, { attestReceipt: pending }).deps;
    expect(await finalizeShift(shift.id, d2)).toMatchObject({ attested: 5 });
    expect(((d2.attestMany as Mock).mock.calls[0][0] as NightAttestation[]).length).toBe(5);
    expect(pending).toHaveBeenCalledWith(TX2, null, null); // that batch reported no nonce or sender
    expect((await nightsOf(shift.id)).slice(20, 40).every((n) => n.attestationUid === null && n.attestTx === TX2)).toBe(true);
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

describe('post-broadcast reconciliation (no double attestation)', () => {
  /** attestMany that broadcasts (onBroadcast) and then loses the receipt. */
  const lostReceipt = (tx: Hex) => vi.fn(async (_ns: NightAttestation[], d: AttestDeps) => {
    await d.onBroadcast?.(tx, 7, SENDER);
    return { skipped: 'error' as const, error: 'timeout', txHash: tx, nonce: 7 };
  });

  it('error after broadcast -> rows stay claimed with attest_tx; a mined receipt fills uids in batch order; never re-sent', async () => {
    const { shift } = await shiftWithNights(3);
    const first = makeDeps(db, { attestMany: lostReceipt(TX2) as never }).deps;
    expect(await finalizeShift(shift.id, first)).toEqual({ attested: 0, skipped: 'unconfirmed' });
    let rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestClaimedAt !== null && n.attestTx === TX2 && n.attestationUid === null)).toBe(true);
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');

    const uids = [uidOf(701), uidOf(702), uidOf(703)];
    const attestReceipt = vi.fn(async () => ({ status: 'success' as const, uids }));
    const { deps, clock } = makeDeps(db, { attestReceipt });
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(deps)).toBe(1);
    rows = await nightsOf(shift.id);
    expect(rows.map((n) => n.attestationUid)).toEqual(uids); // id ascending = the order the batch was sent
    expect(rows.every((n) => n.attestTx === TX2)).toBe(true);
    expect(deps.attestMany).not.toHaveBeenCalled(); // never a second multiAttest for these rows
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', notes: null });
  });

  it('a confirmed revert on reconcile releases the rows, which are then attested exactly once', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestMany: lostReceipt(TX2) as never }).deps);
    const { deps } = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'reverted' as const })) });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 2, txHash: TX });
    expect(deps.attestMany).toHaveBeenCalledTimes(1);
    expect((await nightsOf(shift.id)).every((n) => n.attestationUid !== null && n.attestTx === TX)).toBe(true);
  });

  it('a revert reported by attestMany itself releases at once', async () => {
    const { shift } = await shiftWithNights(2);
    const reverted = vi.fn(async () => ({ skipped: 'error' as const, error: 'reverted', txHash: TX2 }));
    expect(await finalizeShift(shift.id, makeDeps(db, { attestMany: reverted as never }).deps))
      .toEqual({ attested: 0, skipped: 'error' });
    expect((await nightsOf(shift.id)).every((n) => n.attestClaimedAt === null && n.attestTx === null)).toBe(true);
    expect((await getShift(db, shift.id))?.notes).toBe('skipped:error:reverted');
  });

  it('receipt missing: pending (nonce still open) stays claimed however long; dropped (nonce consumed) releases', async () => {
    const { shift } = await shiftWithNights(1);
    await finalizeShift(shift.id, makeDeps(db, { attestMany: lostReceipt(TX2) as never }).deps);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: TX2, attestNonce: 7, attestSender: SENDER });
    const pending = vi.fn(async () => ({ status: 'pending' as const }));
    const late = makeDeps(db, { attestReceipt: pending });
    late.clock.now = new Date(NOW.getTime() + 6 * 3600_000); // hours later: still never released while the nonce is open
    expect(await finalizeShift(shift.id, late.deps)).toEqual({ attested: 0 });
    expect(pending).toHaveBeenCalledWith(TX2, 7, SENDER); // checked against the recorded sender
    expect(late.deps.attestMany).not.toHaveBeenCalled();
    expect((await nightsOf(shift.id))[0].attestClaimedAt).not.toBeNull();

    const dropped = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'dropped' as const })) });
    expect(await finalizeShift(shift.id, dropped.deps)).toEqual({ attested: 1, txHash: TX });
    expect(dropped.deps.attestMany).toHaveBeenCalledTimes(1);
  });

  it('two interleaved reconcilers over the same rows: the slower one cannot release the fresh claim (one multiAttest)', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestMany: lostReceipt(TX2) as never }).deps);
    const both = deferred();
    const goSecond = deferred();
    const goFirst = deferred();
    const firstInFlight = deferred();
    let receipts = 0;
    const attestReceipt = vi.fn(async () => {
      const me = ++receipts;
      if (me === 2) both.resolve();
      await both.promise; // both reconcilers have listed the same (claim, tx) rows
      if (me === 2) await goSecond.promise;
      return { status: 'dropped' as const };
    });
    let sends = 0;
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      const me = ++sends;
      if (me === 1) { firstInFlight.resolve(); await goFirst.promise; } // fresh claim held, tx in flight
      return { uids: ns.map((_, i) => uidOf(100 * me + i)), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestReceipt, attestMany: attestMany as never });
    const done: number[] = [];
    const runs = [finalizeShift(shift.id, deps), finalizeShift(shift.id, deps)].map((p, i) => p.then((r) => { done.push(i); return r; }));
    await firstInFlight.promise; // the faster one released the dropped batch and re-claimed it under a new token
    goSecond.resolve(); // the slower one now acts on its stale view: release (claim T1, tx TX2) must be a no-op
    await until(() => done.length === 1);
    goFirst.resolve();
    const rs = await Promise.all(runs);
    expect(sends).toBe(1);
    expect(rs.reduce((n, r) => n + r.attested, 0)).toBe(2);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual([uidOf(100), uidOf(101)]);
  });

  it('an RPC error or a uid-count mismatch on reconcile leaves the rows claimed', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestMany: lostReceipt(TX2) as never }).deps);
    for (const rc of [{ status: 'error' as const, error: 'timeout' }, { status: 'success' as const, uids: [uidOf(1)] }]) {
      const { deps, clock } = makeDeps(db, { attestReceipt: vi.fn(async () => rc) });
      clock.now = new Date(NOW.getTime() + 2 * 3600_000);
      expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0 });
      expect(deps.attestMany).not.toHaveBeenCalled();
      expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX2 && n.attestClaimedAt !== null && !n.attestationUid)).toBe(true);
    }
  });

  it('attestMany dying after the broadcast (no return) keeps the claim and the tx', async () => {
    const { shift } = await shiftWithNights(2);
    const dies = vi.fn(async (_ns: NightAttestation[], d: AttestDeps) => {
      await d.onBroadcast?.(TX2, 7, SENDER);
      throw new Error('function killed');
    });
    expect(await finalizeShift(shift.id, makeDeps(db, { attestMany: dies as never }).deps)).toMatchObject({ skipped: 'unconfirmed' });
    expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX2 && n.attestClaimedAt !== null)).toBe(true);
  });

  it('a throw after the claim (uid write fails) -> attest_pending, tx kept, the stale pass settles it from the receipt', async () => {
    const { shift } = await shiftWithNights(2);
    let failed = false;
    const flaky = Object.create(db) as Db;
    flaky.execute = ((q: never) => {
      if (!failed) { failed = true; throw new Error('db down'); }
      return db.execute(q);
    }) as Db['execute'];
    const onFinalized = vi.fn(async () => {});
    const { deps } = makeDeps(flaky, { onFinalized });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 0, skipped: 'error' });
    expect(deps.attestMany).toHaveBeenCalledTimes(1);
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:error:error' });
    expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX && n.attestClaimedAt !== null && !n.attestationUid)).toBe(true);
    expect(onFinalized).toHaveBeenCalledTimes(1); // the shift still closes; briefings go out

    const uids = [uidOf(1), uidOf(2)];
    const later = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'success' as const, uids })) });
    later.clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(later.deps)).toBe(1);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual(uids);
    expect(later.deps.attestMany).not.toHaveBeenCalled();
  });
});

describe('stale recovery', () => {
  it('listStaleShifts also returns a finished shift left running', async () => {
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    await updateShift(db, shift.id, { finishedAt: NOW, status: 'running' });
    expect(await listStaleShifts(db, new Date(NOW.getTime() + 30 * 60_000), 45 * 60_000)).toHaveLength(0);
    expect((await listStaleShifts(db, new Date(NOW.getTime() + 46 * 60_000), 45 * 60_000)).map((s) => s.id)).toEqual([shift.id]);
  });

  it('onFinalized fires after the attestation writes', async () => {
    const { shift, projects } = await shiftWithNights(1);
    let seen: string | null | undefined;
    const onFinalized = vi.fn(async () => { seen = (await getNights(db, projects[0].id))[0].attestationUid; });
    await finalizeShift(shift.id, makeDeps(db, { onFinalized }).deps);
    expect(seen).toBe(uidOf(1));
  });

  it('agentId missing or 0 -> nothing attested, rows not claimed, shift attest_pending', async () => {
    const { shift } = await shiftWithNights(1);
    for (const agentId of [undefined, 0n]) {
      const { deps } = makeDeps(db, { agentId });
      expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0, skipped: 'disabled' });
      expect(deps.attestMany).not.toHaveBeenCalled();
    }
    expect((await nightsOf(shift.id))[0].attestClaimedAt).toBeNull();
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:disabled' });
  });

  it('concurrent stale passes lease a finished shift: its receipt is checked once', async () => {
    const { shift } = await shiftWithNights(2);
    const lost = vi.fn(async (_ns: NightAttestation[], d: AttestDeps) => {
      await d.onBroadcast?.(TX2, 7, SENDER);
      return { skipped: 'error' as const, error: 'timeout', txHash: TX2 };
    });
    await finalizeShift(shift.id, makeDeps(db, { attestMany: lost as never }).deps);
    const attestReceipt = vi.fn(async () => ({ status: 'success' as const, uids: [uidOf(1), uidOf(2)] }));
    const { deps, clock } = makeDeps(db, { attestReceipt });
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    const ns = await Promise.all([maybeFinalizeStale(deps), maybeFinalizeStale(deps), maybeFinalizeStale(deps)]);
    expect(ns.reduce((a, b) => a + b, 0)).toBe(1);
    expect(attestReceipt).toHaveBeenCalledTimes(1);
  });

  it('a stale pass stops starting shifts after its wall-clock bound', async () => {
    const a = await shiftWithNights(1, '2026-11-05');
    const { shift: s2 } = await createNightlyShift(db, { night: '2026-11-04', startedAt: new Date(NOW.getTime() - 3600_000), planned: 0 });
    let t = 0;
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      t = 61_000; // the first batch runs past the bound
      return { uids: ns.map((_, i) => uidOf(i + 1)), txHash: TX };
    });
    const { deps, clock } = makeDeps(db, { attestMany: attestMany as never });
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(deps, { maxMs: 60_000, clock: () => t })).toBe(1);
    expect((await getShift(db, a.shift.id))?.status).toBe('attested');
    expect((await getShift(db, s2.id))?.finishedAt).toBeNull(); // never started: over the bound
  });

  it('dispatch does not run the stale pass (tonight first; the route runs it afterwards)', async () => {
    const { shift } = await shiftWithNights(1, '2026-11-05');
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    const { deps, clock } = makeDeps(db);
    clock.now = later;
    const trigger = vi.fn(async () => 'accepted' as const);
    const d = await dispatchShift(later, { ...deps, trigger });
    expect(d.created).toBe(true);
    expect(deps.attestMany).not.toHaveBeenCalled();
    expect((await getShift(db, shift.id))?.finishedAt).toBeNull();
  });
});

describe('claims', () => {
  it('claims at most 20 rows at a time: a pass killed mid-send strands one batch, not the shift', async () => {
    const { shift } = await shiftWithNights(45);
    const claimedDuring: number[] = [];
    const dies = vi.fn(async () => {
      claimedDuring.push((await nightsOf(shift.id)).filter((n) => n.attestClaimedAt !== null).length);
      throw new Error('function killed'); // no broadcast seen: fate unknown, claim kept
    });
    expect(await finalizeShift(shift.id, makeDeps(db, { attestMany: dies as never }).deps)).toMatchObject({ skipped: 'unconfirmed' });
    expect(claimedDuring).toEqual([20]);
    const rows = await nightsOf(shift.id);
    expect(rows.filter((n) => n.attestClaimedAt !== null)).toHaveLength(20);
    expect(new Set(rows.slice(0, 20).map((n) => n.attestClaimId)).size).toBe(1); // one token per claim
    // the next pass sends the other 25 in two fresh claims
    const next = makeDeps(db).deps;
    expect(await finalizeShift(shift.id, next)).toMatchObject({ attested: 25 });
    expect((next.attestMany as Mock).mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([20, 5]);
    const tokens = new Set((await nightsOf(shift.id)).slice(20).map((n) => n.attestClaimId));
    expect(tokens.size).toBe(2);
  });

  it('a release that fails in the never-broadcast branch is retried before finalize returns', async () => {
    const { shift } = await shiftWithNights(2);
    let updates = 0;
    const flaky = Object.create(db) as Db;
    flaky.update = ((t: never) => {
      updates++;
      if (updates === 2) throw new Error('db blip'); // 1 = the claim, 2 = the release after gas_cap
      return db.update(t);
    }) as Db['update'];
    const { deps } = makeDeps(flaky, { attestMany: vi.fn(async () => ({ skipped: 'gas_cap' as const })) as never });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 0 });
    expect((await nightsOf(shift.id)).every((n) => n.attestClaimedAt === null && n.attestClaimId === null)).toBe(true);
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');
  });

  it('writes with a stale claim token are no-ops', async () => {
    const { shift } = await shiftWithNights(1);
    const [row] = await claimShiftNights(db, shift.id, NOW, 'token-a', 20);
    await releaseNightClaims(db, [row.id], 'token-b');
    await markNightsBroadcast(db, [row.id], 'token-b', TX2, 1);
    await setNightAttestations(db, [{ id: row.id, uid: uidOf(1) }], TX2, 'token-b');
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestClaimId: 'token-a', attestTx: null, attestationUid: null });
    await markNightsBroadcast(db, [row.id], 'token-a', TX2, 1);
    await releaseNightClaims(db, [row.id], 'token-a', TX); // reconcile release for another tx: no-op
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestClaimId: 'token-a', attestTx: TX2, attestNonce: 1 });
    await setNightAttestations(db, [{ id: row.id, uid: uidOf(1) }], TX, 'token-a'); // uids from a different tx: no-op
    expect((await nightsOf(shift.id))[0].attestationUid).toBeNull();
    await setNightAttestations(db, [{ id: row.id, uid: uidOf(1) }], TX2, 'token-a');
    expect((await nightsOf(shift.id))[0].attestationUid).toBe(uidOf(1));
  });

  it('an unfinished stale shift is leased: concurrent stale passes work it once', async () => {
    const { shift } = await shiftWithNights(2);
    const { deps, clock } = makeDeps(db);
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    const ns = await Promise.all([maybeFinalizeStale(deps), maybeFinalizeStale(deps)]);
    expect(ns.reduce((a, b) => a + b, 0)).toBe(1);
    expect(deps.attestMany).toHaveBeenCalledTimes(1);
    expect((await getShift(db, shift.id))?.status).toBe('attested');
  });

  it('attested counts only the rows actually written', async () => {
    const { shift } = await shiftWithNights(2);
    const attestMany = vi.fn(async (ns: NightAttestation[]) => {
      const [firstRow] = await nightsOf(shift.id);
      await db.update(nights).set({ attestClaimId: 'someone-else' }).where(eq(nights.id, firstRow.id)); // token no longer ours
      return { uids: ns.map((_, i) => uidOf(i + 1)), txHash: TX };
    });
    const r = await finalizeShift(shift.id, makeDeps(db, { attestMany: attestMany as never }).deps);
    expect(r.attested).toBe(1);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual([null, uidOf(2)]);
  });
});

describe('real attestMany with a local signer (no chain)', () => {
  const SIGNED = ('0x02' + 'cd'.repeat(90)) as Hex;
  const HASH_OF_SIGNED = keccak256(SIGNED);
  const fakeSigner = (sendErr?: Error) => {
    const sendRawTransaction = vi.fn(async () => {
      if (sendErr) throw sendErr;
      return HASH_OF_SIGNED;
    });
    const wallet = { account: { address: SENDER }, chain: undefined, signTransaction: vi.fn(async () => SIGNED), sendRawTransaction };
    const publicClient = {
      estimateContractGas: vi.fn(async () => 200_000n),
      getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000n })),
      estimateMaxPriorityFeePerGas: vi.fn(async () => 1_000_000n),
      getTransactionCount: vi.fn(async () => 11),
      waitForTransactionReceipt: vi.fn(),
    };
    return { signer: { wallet, publicClient } as unknown as ShiftDeps['signer'], sendRawTransaction };
  };

  it('send fails after the persist -> claim kept with attest_tx + nonce + sender, no release, no gas refund', async () => {
    const { shift } = await shiftWithNights(2);
    const { signer, sendRawTransaction } = fakeSigner(Object.assign(new Error('already known'), { name: 'TimeoutError' }));
    const release = vi.fn(async () => undefined);
    const { deps } = makeDeps(db, { attestMany: realAttestMany, signer, release });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 0, skipped: 'unconfirmed' });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    const rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestClaimedAt !== null && n.attestTx === HASH_OF_SIGNED && n.attestNonce === 11 && n.attestSender === SENDER))
      .toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'unconfirmed:timeout' });

    // the next pass checks that tx against its recorded nonce and sender, and sends nothing new while it may mine
    const attestReceipt = vi.fn(async () => ({ status: 'pending' as const }));
    const later = makeDeps(db, { attestMany: realAttestMany, signer, attestReceipt });
    expect(await finalizeShift(shift.id, later.deps)).toEqual({ attested: 0 });
    expect(attestReceipt).toHaveBeenCalledWith(HASH_OF_SIGNED, 11, SENDER);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
