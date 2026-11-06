import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, NOW, TX, uidOf, until } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns, nightManifests, nights, shifts, type NightRow } from '@/lib/db/schema';
import {
  createNightlyShift, getEvidence, getNightManifest, getNights, getShift, insertNight, listStaleShifts, updateShift,
  claimShiftNights, releaseNightClaims, markNightsBroadcast, setNightAttestations, type NightProofBatch,
} from '@/lib/db/queries';
import { dispatchShift } from '@/lib/shift/dispatch';
import { ATTEST_BATCH, finalizeShift, maybeFinalizeStale } from '@/lib/shift/finalize';
import { getNightView } from '@/lib/views/night';
import { runProject, runShiftProject, liveWindow } from '@/lib/shift/run';
import {
  attestRoot as realAttestRoot, decodeRoot, rootSchemaUid, type AttestDeps, type NightAttestation, type NightRoot,
} from '@/lib/attest/eas';
import { EAS_ADDRESS, easAbi } from '@/lib/attest/abi';
import { nightLeaf } from '@/lib/attest/manifest';
import { verifyProof } from '@/lib/attest/merkle';
import type { ShiftDeps } from '@/lib/shift/deps';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, toBytes, zeroAddress, type Hex } from 'viem';
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
/** The NightRoot handed to the i-th attestRoot call. */
const rootArg = (m: unknown, i = 0) => (m as Mock).mock.calls[i][0] as NightRoot;
/** Every row carries a proof that leads from its own leaf to the batch root. */
const proven = (n: NightRow) => !!n.attestLeaf && !!n.attestRoot && Array.isArray(n.attestProof)
  && verifyProof(n.attestLeaf as Hex, n.attestProof as Hex[], n.attestRoot as Hex);

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
    // the refused project got an `unavailable` night; both are covered by one root
    expect((await getNights(db, a.id))[0]).toMatchObject({ status: 'unavailable', shiftId: d.shiftId });
    expect(rootArg(deps.attestRoot).count).toBe(2);
  });

  it('an empty watch list finalizes immediately', async () => {
    const trigger = vi.fn(async () => 'accepted' as const);
    const { deps } = makeDeps(db);
    const d = await dispatchShift(NOW, { ...deps, trigger });
    expect(d).toMatchObject({ planned: 0, created: true });
    expect((await getShift(db, d.shiftId))?.finishedAt).not.toBeNull();
  });
});

describe('finalizeShift: one Merkle root per night', () => {
  it('one root for N rows: the manifest lists every leaf, every row gets the root uid and its own proof; a second pass attests 0', async () => {
    const { shift, projects } = await shiftWithNights(3);
    const onFinalized = vi.fn(async () => {});
    const { deps } = makeDeps(db, { onFinalized });
    const r1 = await finalizeShift(shift.id, deps);
    expect(r1).toEqual({ attested: 3, txHash: TX });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0 });
    expect(deps.attestRoot).toHaveBeenCalledTimes(1);

    const att = rootArg(deps.attestRoot);
    expect(att).toMatchObject({ night: 20261106, count: 3, agentId: 42n });
    const hash = att.manifestURI.split('/api/v1/manifest/')[1] as Hex;
    expect(att.manifestURI).toBe(`https://lights-on.vercel.app/api/v1/manifest/${hash}`);
    const manifest = (await getNightManifest(db, hash))!;
    expect(manifest).toMatchObject({ v: 1, schema: 'lights-on/night-manifest', night: 20261106, count: 3, root: att.root, agentId: '42' });

    const rows = await nightsOf(shift.id);
    expect(rows.map((n) => n.attestationUid)).toEqual([uidOf(1), uidOf(1), uidOf(1)]); // the ROOT attestation's uid
    for (const [i, n] of rows.entries()) {
      expect(n).toMatchObject({ attestTx: TX, attestRoot: att.root, attestManifest: hash, attestLit30: 1 });
      expect(proven(n)).toBe(true);
      const projectKey = keccak256(toBytes(projects[i].slug));
      expect(n.attestLeaf).toBe(nightLeaf({ projectKey, night: 20261106, status: 1, lit30: 1, evidenceHash: HASH(i) as Hex }));
      expect(manifest.leaves.find((l) => l.slug === projects[i].slug)).toEqual({
        slug: projects[i].slug, projectKey, night: 20261106, kind: 0, status: 'shipped', statusCode: 1, lit30: 1,
        evidenceHash: HASH(i), leaf: n.attestLeaf,
      });
    }
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', attestTxs: [TX] });
    expect(onFinalized).toHaveBeenCalledTimes(1);
    expect(onFinalized).toHaveBeenCalledWith(shift.id);
  });

  it('a shift of <= 500 nights is exactly one transaction', async () => {
    expect(ATTEST_BATCH).toBe(500);
    const { shift } = await shiftWithNights(45);
    const { deps } = makeDeps(db);
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 45, txHash: TX });
    expect(deps.attestRoot).toHaveBeenCalledTimes(1);
    expect(rootArg(deps.attestRoot).count).toBe(45);
    const rows = await nightsOf(shift.id);
    expect(new Set(rows.map((n) => n.attestationUid))).toEqual(new Set([uidOf(1)]));
    expect(rows.every(proven)).toBe(true);
    expect(await db.select().from(nightManifests)).toHaveLength(1);
  });

  it('more than one batch: one root per batch, every root tx kept on the shift as its own entry (and shown on /night)', async () => {
    const { shift, projects } = await shiftWithNights(45); // 20 + 20 + 5 with a 20-row batch
    const txOf = (i: number) => `0x${(i + 1).toString(16).padStart(64, '7')}` as Hex;
    let call = 0;
    const attestRoot = vi.fn(async () => ({ uid: uidOf(call + 1), txHash: txOf(call++) }));
    const { deps } = makeDeps(db, { attestRoot: attestRoot as never, attestBatch: 20 });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 45, txHash: txOf(2) });
    expect(attestRoot.mock.calls.map((_, i) => rootArg(attestRoot, i).count)).toEqual([20, 20, 5]);
    expect(new Set(attestRoot.mock.calls.map((_, i) => rootArg(attestRoot, i).root)).size).toBe(3);
    const s = await getShift(db, shift.id);
    expect(s?.attestTxs).toEqual([txOf(0), txOf(1), txOf(2)]);
    const rows = await nightsOf(shift.id);
    expect(rows.slice(20, 40).every((n) => n.attestationUid === uidOf(2) && n.attestRoot === rootArg(attestRoot, 1).root)).toBe(true);
    expect(rows.every(proven)).toBe(true);
    expect((await getNights(db, projects[44].id))[0].attestTx).toBe(txOf(2));
    expect((await getNightView(db)).txs).toEqual([txOf(0), txOf(1), txOf(2)]);
  });

  it('concurrent finalizes attest each row exactly once', async () => {
    const { shift } = await shiftWithNights(4);
    const { deps } = makeDeps(db);
    const rs = await Promise.all([finalizeShift(shift.id, deps), finalizeShift(shift.id, deps), finalizeShift(shift.id, deps)]);
    expect(rs.reduce((n, r) => n + r.attested, 0)).toBe(4);
    const total = (deps.attestRoot as Mock).mock.calls.reduce((n, _c, i) => n + rootArg(deps.attestRoot, i).count, 0);
    expect(total).toBe(4);
    expect((await nightsOf(shift.id)).every((n) => n.attestationUid !== null && proven(n))).toBe(true);
  });

  it('live run during finalize does not touch the nights row (Review Focus 4)', async () => {
    const { shift, projects } = await shiftWithNights(1);
    const p = projects[0];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const attestRoot = vi.fn(async () => {
      await gate;
      return { uid: uidOf(500), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestRoot: attestRoot as never });

    const fin = finalizeShift(shift.id, deps);
    await until(() => attestRoot.mock.calls.length === 1); // rows claimed, tx in flight
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
    expect(attestRoot).toHaveBeenCalledTimes(1);
    expect(((deps.attest as Mock).mock.calls[0][0] as NightAttestation).kind).toBe(1); // live keeps its per-project attestation
    expect(await db.select().from(liveRuns)).toHaveLength(1);
  });

  it('attest skipped -> claims released, shift attest_pending, a later finalize retries', async () => {
    const { shift, projects } = await shiftWithNights(2);
    const onFinalized = vi.fn(async () => {});
    const skip = makeDeps(db, { attestRoot: vi.fn(async () => ({ skipped: 'gas_cap' as const })) as never, onFinalized }).deps;
    expect(await finalizeShift(shift.id, skip)).toEqual({ attested: 0, skipped: 'gas_cap' });
    const n0 = (await getNights(db, projects[0].id))[0];
    expect(n0).toMatchObject({ attestationUid: null, attestClaimedAt: null, attestRoot: null, attestProof: null });
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

  it('a broadcast batch with an unknown outcome stays claimed with its tx AND proofs; later batches are released', async () => {
    const { shift } = await shiftWithNights(45);
    let call = 0;
    const attestRoot = vi.fn(async () => {
      call++;
      if (call === 2) return { skipped: 'error' as const, error: 'timeout', txHash: TX2 }; // sent, receipt wait failed
      return { uid: uidOf(call * 100), txHash: TX };
    });
    const { deps } = makeDeps(db, { attestRoot: attestRoot as never, attestBatch: 20 });
    const r = await finalizeShift(shift.id, deps);
    expect(attestRoot.mock.calls.map((_, i) => rootArg(attestRoot, i).count)).toEqual([20, 20]);
    expect(r).toEqual({ attested: 20, txHash: TX, skipped: 'unconfirmed' });
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'unconfirmed:timeout' });
    const rows = await nightsOf(shift.id);
    const batch2 = rows.slice(20, 40);
    expect(batch2.every((n) => n.attestClaimedAt !== null && n.attestTx === TX2 && n.attestationUid === null)).toBe(true);
    expect(batch2.every((n) => proven(n) && n.attestRoot === rootArg(attestRoot, 1).root)).toBe(true);
    expect(rows.slice(40).every((n) => n.attestClaimedAt === null && n.attestTx === null && n.attestRoot === null)).toBe(true);

    // next pass: receipt not there yet -> batch 2 untouched; only the 5 never-sent rows go out
    const pending = vi.fn(async () => ({ status: 'pending' as const }));
    const d2 = makeDeps(db, { attestReceipt: pending }).deps;
    expect(await finalizeShift(shift.id, d2)).toMatchObject({ attested: 5 });
    expect(rootArg(d2.attestRoot).count).toBe(5);
    expect(pending).toHaveBeenCalledWith(TX2, null, null); // that batch reported no nonce or sender
    expect((await nightsOf(shift.id)).slice(20, 40).every((n) => n.attestationUid === null && n.attestTx === TX2)).toBe(true);
  });

  it('lit30 counts reconstructed nights (observed wins on the same night) and is what the leaf commits to', async () => {
    const { shift, projects } = await shiftWithNights(1);
    const pid = projects[0].id;
    await insertNight(db, { projectId: pid, night: '2026-11-01', status: 'building', observed: false });
    await insertNight(db, { projectId: pid, night: '2026-11-02', status: 'shipped', observed: false });
    await insertNight(db, { projectId: pid, night: '2026-11-02', status: 'quiet', observed: true });
    await insertNight(db, { projectId: pid, night: '2026-09-01', status: 'shipped', observed: false });
    const { deps } = makeDeps(db);
    await finalizeShift(shift.id, deps);
    const [row] = (await nightsOf(shift.id));
    expect(row.attestLit30).toBe(2);
    const manifest = (await getNightManifest(db, row.attestManifest!))!;
    expect(manifest.leaves[0]).toMatchObject({ lit30: 2, leaf: row.attestLeaf });
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
    const { deps } = makeDeps(db, { attestRoot: vi.fn(async () => ({ skipped: 'disabled' as const })) as never });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0, skipped: 'disabled' });
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');
  });
});

describe('post-broadcast reconciliation (no double attestation)', () => {
  /** attestRoot that broadcasts (onBroadcast) and then loses the receipt. */
  const lostReceipt = (tx: Hex) => vi.fn(async (_r: NightRoot, d: AttestDeps) => {
    await d.onBroadcast?.(tx, 7, SENDER);
    return { skipped: 'error' as const, error: 'timeout', txHash: tx, nonce: 7 };
  });

  it('error after broadcast -> rows stay claimed with tx + proofs; a mined receipt writes its ONE uid to every row; never re-sent', async () => {
    const { shift } = await shiftWithNights(3);
    const first = makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps;
    expect(await finalizeShift(shift.id, first)).toEqual({ attested: 0, skipped: 'unconfirmed' });
    let rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestClaimedAt !== null && n.attestTx === TX2 && n.attestationUid === null && proven(n))).toBe(true);
    const stored = rows.map((n) => [n.attestLeaf, n.attestProof, n.attestRoot]);
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');

    const attestReceipt = vi.fn(async () => ({ status: 'success' as const, uids: [uidOf(701)] }));
    const { deps, clock } = makeDeps(db, { attestReceipt });
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(deps)).toBe(1);
    rows = await nightsOf(shift.id);
    expect(rows.map((n) => n.attestationUid)).toEqual([uidOf(701), uidOf(701), uidOf(701)]);
    expect(rows.map((n) => [n.attestLeaf, n.attestProof, n.attestRoot])).toEqual(stored); // the proofs persisted before the send
    expect(rows.every((n) => n.attestTx === TX2 && proven(n))).toBe(true);
    expect(deps.attestRoot).not.toHaveBeenCalled(); // never a second root for these rows
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', notes: null });
  });

  it('a confirmed revert on reconcile releases the rows (proofs too), which are then attested exactly once', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps);
    const { deps } = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'reverted' as const })) });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 2, txHash: TX });
    expect(deps.attestRoot).toHaveBeenCalledTimes(1);
    expect((await nightsOf(shift.id)).every((n) => n.attestationUid !== null && n.attestTx === TX && proven(n))).toBe(true);
  });

  it('a revert reported by attestRoot itself releases at once', async () => {
    const { shift } = await shiftWithNights(2);
    const reverted = vi.fn(async () => ({ skipped: 'error' as const, error: 'reverted', txHash: TX2 }));
    expect(await finalizeShift(shift.id, makeDeps(db, { attestRoot: reverted as never }).deps))
      .toEqual({ attested: 0, skipped: 'error' });
    expect((await nightsOf(shift.id)).every((n) => n.attestClaimedAt === null && n.attestTx === null && n.attestRoot === null)).toBe(true);
    expect((await getShift(db, shift.id))?.notes).toBe('skipped:error:reverted');
  });

  it('receipt missing: pending (nonce still open) stays claimed however long; dropped (nonce consumed) releases', async () => {
    const { shift } = await shiftWithNights(1);
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: TX2, attestNonce: 7, attestSender: SENDER });
    const pending = vi.fn(async () => ({ status: 'pending' as const }));
    const late = makeDeps(db, { attestReceipt: pending });
    late.clock.now = new Date(NOW.getTime() + 6 * 3600_000); // hours later: still never released while the nonce is open
    expect(await finalizeShift(shift.id, late.deps)).toEqual({ attested: 0 });
    expect(pending).toHaveBeenCalledWith(TX2, 7, SENDER); // checked against the recorded sender
    expect(late.deps.attestRoot).not.toHaveBeenCalled();
    expect((await nightsOf(shift.id))[0].attestClaimedAt).not.toBeNull();

    const dropped = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'dropped' as const })) });
    dropped.clock.now = new Date(NOW.getTime() + 11 * 60_000); // persisted >= 10 min ago
    expect(await finalizeShift(shift.id, dropped.deps)).toEqual({ attested: 1, txHash: TX });
    expect(dropped.deps.attestRoot).toHaveBeenCalledTimes(1);
  });

  it('dropped is acted on only once the persist is >= 10 min old (a lagging RPC replica may not know a fresh tx)', async () => {
    const { shift } = await shiftWithNights(1);
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: TX2, attestSentAt: NOW });
    const young = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'dropped' as const })) });
    young.clock.now = new Date(NOW.getTime() + 9 * 60_000 + 59_000);
    expect(await finalizeShift(shift.id, young.deps)).toEqual({ attested: 0 }); // treated as pending
    expect(young.deps.attestReceipt).toHaveBeenCalledWith(TX2, 7, SENDER);
    expect(young.deps.attestRoot).not.toHaveBeenCalled();
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: TX2, attestNonce: 7, attestationUid: null, attestSentAt: NOW });
    expect((await nightsOf(shift.id))[0].attestClaimId).not.toBeNull();

    const old = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'dropped' as const })) });
    old.clock.now = new Date(NOW.getTime() + 10 * 60_000);
    expect(await finalizeShift(shift.id, old.deps)).toEqual({ attested: 1, txHash: TX });
    expect(old.deps.attestRoot).toHaveBeenCalledTimes(1);
  });

  it('two interleaved reconcilers over the same rows: the slower one cannot release the fresh claim (one root sent)', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps);
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
    const attestRoot = vi.fn(async () => {
      const me = ++sends;
      if (me === 1) { firstInFlight.resolve(); await goFirst.promise; } // fresh claim held, tx in flight
      return { uid: uidOf(100 * me), txHash: TX };
    });
    const { deps, clock } = makeDeps(db, { attestReceipt, attestRoot: attestRoot as never });
    clock.now = new Date(NOW.getTime() + 11 * 60_000); // the dropped tx was persisted >= 10 min ago
    const done: number[] = [];
    const runs = [finalizeShift(shift.id, deps), finalizeShift(shift.id, deps)].map((p, i) => p.then((r) => { done.push(i); return r; }));
    await firstInFlight.promise; // the faster one released the dropped batch and re-claimed it under a new token
    goSecond.resolve(); // the slower one now acts on its stale view: release (claim T1, tx TX2) must be a no-op
    await until(() => done.length === 1);
    goFirst.resolve();
    const rs = await Promise.all(runs);
    expect(sends).toBe(1);
    expect(rs.reduce((n, r) => n + r.attested, 0)).toBe(2);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual([uidOf(100), uidOf(100)]);
  });

  it('an RPC error, a uid count other than 1, or stored proofs that do not check out leave the rows claimed', async () => {
    const { shift } = await shiftWithNights(2);
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lostReceipt(TX2) as never }).deps);
    for (const rc of [
      { status: 'error' as const, error: 'timeout' },
      { status: 'success' as const, uids: [uidOf(1), uidOf(2)] },
      { status: 'success' as const, uids: [] },
    ]) {
      const { deps, clock } = makeDeps(db, { attestReceipt: vi.fn(async () => rc) });
      clock.now = new Date(NOW.getTime() + 2 * 3600_000);
      expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0 });
      expect(deps.attestRoot).not.toHaveBeenCalled();
      expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX2 && n.attestClaimedAt !== null && !n.attestationUid)).toBe(true);
    }
    // a row whose stored proof no longer leads to the batch root: never written, never released
    const [first] = await nightsOf(shift.id);
    await db.update(nights).set({ attestProof: [`0x${'99'.repeat(32)}`] }).where(eq(nights.id, first.id));
    const { deps, clock } = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'success' as const, uids: [uidOf(9)] })) });
    clock.now = new Date(NOW.getTime() + 2 * 3600_000);
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0 });
    expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX2 && n.attestClaimedAt !== null && !n.attestationUid)).toBe(true);
  });

  it('attestRoot dying after the broadcast (no return) keeps the claim, the tx and the proofs', async () => {
    const { shift } = await shiftWithNights(2);
    const dies = vi.fn(async (_r: NightRoot, d: AttestDeps) => {
      await d.onBroadcast?.(TX2, 7, SENDER);
      throw new Error('function killed');
    });
    expect(await finalizeShift(shift.id, makeDeps(db, { attestRoot: dies as never }).deps)).toMatchObject({ skipped: 'unconfirmed' });
    expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX2 && n.attestClaimedAt !== null && proven(n))).toBe(true);
  });

  it('a throw after the claim (uid write fails) -> attest_pending, tx + proofs kept, the stale pass settles it from the receipt', async () => {
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
    expect(deps.attestRoot).toHaveBeenCalledTimes(1);
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:error:error' });
    expect((await nightsOf(shift.id)).every((n) => n.attestTx === TX && n.attestClaimedAt !== null && !n.attestationUid && proven(n))).toBe(true);
    expect(onFinalized).toHaveBeenCalledTimes(1); // the shift still closes; briefings go out

    const later = makeDeps(db, { attestReceipt: vi.fn(async () => ({ status: 'success' as const, uids: [uidOf(1)] })) });
    later.clock.now = new Date(NOW.getTime() + 46 * 60_000);
    expect(await maybeFinalizeStale(later.deps)).toBe(1);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual([uidOf(1), uidOf(1)]);
    expect(later.deps.attestRoot).not.toHaveBeenCalled();
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

  it('agentId missing or 0 -> nothing attested, rows not claimed, no manifest, shift attest_pending', async () => {
    const { shift } = await shiftWithNights(1);
    for (const agentId of [undefined, 0n]) {
      const { deps } = makeDeps(db, { agentId });
      expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0, skipped: 'disabled' });
      expect(deps.attestRoot).not.toHaveBeenCalled();
    }
    expect((await nightsOf(shift.id))[0].attestClaimedAt).toBeNull();
    expect(await db.select().from(nightManifests)).toHaveLength(0);
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:disabled' });
  });

  it('concurrent stale passes lease a finished shift: its receipt is checked once', async () => {
    const { shift } = await shiftWithNights(2);
    const lost = vi.fn(async (_r: NightRoot, d: AttestDeps) => {
      await d.onBroadcast?.(TX2, 7, SENDER);
      return { skipped: 'error' as const, error: 'timeout', txHash: TX2 };
    });
    await finalizeShift(shift.id, makeDeps(db, { attestRoot: lost as never }).deps);
    const attestReceipt = vi.fn(async () => ({ status: 'success' as const, uids: [uidOf(1)] }));
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
    const attestRoot = vi.fn(async () => {
      t = 61_000; // the first batch runs past the bound
      return { uid: uidOf(1), txHash: TX };
    });
    const { deps, clock } = makeDeps(db, { attestRoot: attestRoot as never });
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
    expect(deps.attestRoot).not.toHaveBeenCalled();
    expect((await getShift(db, shift.id))?.finishedAt).toBeNull();
  });
});

/** A one-row batch for direct query tests (a single leaf: root = leaf, empty proof). */
const oneRow = (id: number, leaf = HASH(900)): NightProofBatch => ({ root: leaf, manifest: HASH(901), rows: [{ id, leaf, proof: [], lit30: 3 }] });

describe('claims', () => {
  it('claims at most one batch at a time: a pass killed mid-send strands one batch, not the shift', async () => {
    const { shift } = await shiftWithNights(45);
    const claimedDuring: number[] = [];
    const dies = vi.fn(async () => {
      claimedDuring.push((await nightsOf(shift.id)).filter((n) => n.attestClaimedAt !== null).length);
      throw new Error('function killed'); // no broadcast seen: fate unknown, claim kept
    });
    expect(await finalizeShift(shift.id, makeDeps(db, { attestRoot: dies as never, attestBatch: 20 }).deps)).toMatchObject({ skipped: 'unconfirmed' });
    expect(claimedDuring).toEqual([20]);
    const rows = await nightsOf(shift.id);
    expect(rows.filter((n) => n.attestClaimedAt !== null)).toHaveLength(20);
    expect(new Set(rows.slice(0, 20).map((n) => n.attestClaimId)).size).toBe(1); // one token per claim
    // the next pass sends the other 25 in two fresh claims
    const next = makeDeps(db, { attestBatch: 20 }).deps;
    expect(await finalizeShift(shift.id, next)).toMatchObject({ attested: 25 });
    expect((next.attestRoot as Mock).mock.calls.map((_, i) => rootArg(next.attestRoot, i).count)).toEqual([20, 5]);
    const tokens = new Set((await nightsOf(shift.id)).slice(20).map((n) => n.attestClaimId));
    expect(tokens.size).toBe(2);
  });

  it('a tx-less claim older than 10 min is taken over under a new token and sent once; a 5-min-old one is not', async () => {
    const { shift } = await shiftWithNights(3);
    const dies = vi.fn(async () => { throw new Error('function killed'); }); // died before signing: no tx persisted
    expect(await finalizeShift(shift.id, makeDeps(db, { attestRoot: dies as never }).deps)).toMatchObject({ skipped: 'unconfirmed' });
    const tokens = new Set((await nightsOf(shift.id)).map((n) => n.attestClaimId));
    expect(tokens.size).toBe(1);
    const [t1] = [...tokens];
    expect(t1).toBeTruthy();

    const at5 = makeDeps(db);
    at5.clock.now = new Date(NOW.getTime() + 5 * 60_000);
    expect(await finalizeShift(shift.id, at5.deps)).toEqual({ attested: 0 });
    expect(at5.deps.attestRoot).not.toHaveBeenCalled();
    expect((await nightsOf(shift.id)).every((n) => n.attestClaimId === t1 && n.attestationUid === null)).toBe(true);

    const at11 = makeDeps(db);
    at11.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    expect(await finalizeShift(shift.id, at11.deps)).toEqual({ attested: 3, txHash: TX });
    expect(at11.deps.attestRoot).toHaveBeenCalledTimes(1);
    expect(rootArg(at11.deps.attestRoot).count).toBe(3);
    const rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestationUid !== null && n.attestClaimId !== t1)).toBe(true);
    expect(new Set(rows.map((n) => n.attestClaimId)).size).toBe(1); // one new token
    expect(rows.every((n) => n.attestClaimedAt?.getTime() === at11.clock.now.getTime())).toBe(true);
    expect(await finalizeShift(shift.id, at11.deps)).toEqual({ attested: 0 }); // sent once
    expect(at11.deps.attestRoot).toHaveBeenCalledTimes(1);
  });

  it('a stale claim WITH a persisted tx is never taken over by a claim (reconcile owns it)', async () => {
    const { shift } = await shiftWithNights(1);
    const [row] = await claimShiftNights(db, shift.id, NOW, 'token-a', 20);
    expect(await markNightsBroadcast(db, oneRow(row.id), 'token-a', TX2, 3, SENDER, NOW)).toBe(1);
    expect(await claimShiftNights(db, shift.id, new Date(NOW.getTime() + 24 * 3600_000), 'token-b', 20)).toEqual([]);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestClaimId: 'token-a', attestTx: TX2 });
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
    const { deps } = makeDeps(flaky, { attestRoot: vi.fn(async () => ({ skipped: 'gas_cap' as const })) as never });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 0 });
    expect((await nightsOf(shift.id)).every((n) => n.attestClaimedAt === null && n.attestClaimId === null)).toBe(true);
    expect((await getShift(db, shift.id))?.status).toBe('attest_pending');
  });

  it('writes with a stale claim token, another tx or another root are no-ops', async () => {
    const { shift } = await shiftWithNights(1);
    const [row] = await claimShiftNights(db, shift.id, NOW, 'token-a', 20);
    const b = oneRow(row.id);
    await releaseNightClaims(db, [row.id], 'token-b');
    expect(await markNightsBroadcast(db, b, 'token-b', TX2, 1, null, NOW)).toBe(0);
    expect(await setNightAttestations(db, b, uidOf(1), TX2, 'token-b')).toBe(0);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestClaimId: 'token-a', attestTx: null, attestationUid: null, attestRoot: null });
    expect(await markNightsBroadcast(db, b, 'token-a', TX2, 1, null, NOW)).toBe(1);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestRoot: b.root, attestLeaf: b.rows[0].leaf, attestProof: [], attestLit30: 3, attestManifest: b.manifest });
    const later = new Date(NOW.getTime() + 3600_000);
    expect(await markNightsBroadcast(db, b, 'token-a', TX2, null, null, later)).toBe(1); // re-mark, same tx
    expect(await markNightsBroadcast(db, b, 'token-a', TX, 2, null, later)).toBe(0); // never swaps the tx
    expect(await markNightsBroadcast(db, oneRow(row.id, HASH(902)), 'token-a', TX2, 2, null, later)).toBe(0); // nor the root
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: TX2, attestNonce: 1, attestSentAt: NOW, attestRoot: b.root }); // first persist kept
    await releaseNightClaims(db, [row.id], 'token-a', TX); // reconcile release for another tx: no-op
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestClaimId: 'token-a', attestTx: TX2, attestNonce: 1 });
    expect(await setNightAttestations(db, b, uidOf(1), TX, 'token-a')).toBe(0); // a uid from a different tx: no-op
    expect(await setNightAttestations(db, oneRow(row.id, HASH(902)), uidOf(1), TX2, 'token-a')).toBe(0); // or for another root
    expect((await nightsOf(shift.id))[0].attestationUid).toBeNull();
    expect(await setNightAttestations(db, b, uidOf(1), TX2, 'token-a')).toBe(1);
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestationUid: uidOf(1), attestRoot: b.root, attestProof: [] });
    await releaseNightClaims(db, [row.id], 'token-a', TX2); // an attested row is never released
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestationUid: uidOf(1), attestRoot: b.root });
  });

  it('a release clears the tx and every Merkle field', async () => {
    const { shift } = await shiftWithNights(1);
    const [row] = await claimShiftNights(db, shift.id, NOW, 'token-a', 20);
    await markNightsBroadcast(db, oneRow(row.id), 'token-a', TX2, 1, SENDER, NOW);
    await releaseNightClaims(db, [row.id], 'token-a', TX2);
    expect((await nightsOf(shift.id))[0]).toMatchObject({
      attestClaimId: null, attestTx: null, attestNonce: null, attestSender: null, attestSentAt: null,
      attestRoot: null, attestLeaf: null, attestProof: null, attestLit30: null, attestManifest: null,
    });
  });

  it('a malformed proof batch is refused before any write', async () => {
    const { shift } = await shiftWithNights(1);
    const [row] = await claimShiftNights(db, shift.id, NOW, 'token-a', 20);
    const bad = { ...oneRow(row.id), rows: [{ id: row.id, leaf: HASH(900), proof: ["0x1'}"], lit30: 3 }] };
    await expect(markNightsBroadcast(db, bad, 'token-a', TX2, 1, SENDER, NOW)).rejects.toThrow();
    expect((await nightsOf(shift.id))[0]).toMatchObject({ attestTx: null, attestRoot: null });
  });

  it('an unfinished stale shift is leased: concurrent stale passes work it once', async () => {
    const { shift } = await shiftWithNights(2);
    const { deps, clock } = makeDeps(db);
    clock.now = new Date(NOW.getTime() + 46 * 60_000);
    const ns = await Promise.all([maybeFinalizeStale(deps), maybeFinalizeStale(deps)]);
    expect(ns.reduce((a, b) => a + b, 0)).toBe(1);
    expect(deps.attestRoot).toHaveBeenCalledTimes(1);
    expect((await getShift(db, shift.id))?.status).toBe('attested');
  });

  it('attested counts only the rows actually written', async () => {
    const { shift } = await shiftWithNights(2);
    const attestRoot = vi.fn(async () => {
      const [firstRow] = await nightsOf(shift.id);
      await db.update(nights).set({ attestClaimId: 'someone-else' }).where(eq(nights.id, firstRow.id)); // token no longer ours
      return { uid: uidOf(1), txHash: TX };
    });
    const r = await finalizeShift(shift.id, makeDeps(db, { attestRoot: attestRoot as never }).deps);
    expect(r.attested).toBe(1);
    expect((await nightsOf(shift.id)).map((n) => n.attestationUid)).toEqual([null, uidOf(1)]);
  });
});

describe('real attestRoot with a local signer (no chain)', () => {
  const SIGNED = ('0x02' + 'cd'.repeat(90)) as Hex;
  const HASH_OF_SIGNED = keccak256(SIGNED);
  const ROOT_UID = keccak256(toBytes('root-uid'));
  const attestedLog = (uid: Hex) => ({
    address: EAS_ADDRESS,
    topics: encodeEventTopics({ abi: easAbi, eventName: 'Attested', args: { recipient: zeroAddress, attester: SENDER, schemaUID: rootSchemaUid() } }),
    data: encodeAbiParameters([{ type: 'bytes32' }], [uid]),
  });
  const fakeSigner = (o: { sendErr?: Error; onSign?: () => Promise<void>; onSend?: () => Promise<void>; mined?: boolean } = {}) => {
    const sendRawTransaction = vi.fn(async () => {
      await o.onSend?.();
      if (o.sendErr) throw o.sendErr;
      return HASH_OF_SIGNED;
    });
    const signTransaction = vi.fn(async (_tx: unknown) => { await o.onSign?.(); return SIGNED; });
    const wallet = { account: { address: SENDER }, chain: undefined, signTransaction, sendRawTransaction };
    const publicClient = {
      estimateContractGas: vi.fn(async () => 200_000n),
      getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000n })),
      estimateMaxPriorityFeePerGas: vi.fn(async () => 1_000_000n),
      getTransactionCount: vi.fn(async () => 11),
      waitForTransactionReceipt: vi.fn(async () => {
        if (!o.mined) throw Object.assign(new Error('x'), { name: 'WaitForTransactionReceiptTimeoutError' });
        return { status: 'success', transactionHash: HASH_OF_SIGNED, logs: [attestedLog(ROOT_UID)] };
      }),
    };
    return { signer: { wallet, publicClient } as unknown as ShiftDeps['signer'], sendRawTransaction, signTransaction };
  };

  it('mined: ONE attest of the root; manifest stored before signing, proofs persisted before the send, uid on every row', async () => {
    const { shift } = await shiftWithNights(5);
    const atSign: number[] = [];
    let atSend: NightRow[] = [];
    const { signer, signTransaction, sendRawTransaction } = fakeSigner({
      mined: true,
      onSign: async () => { atSign.push((await db.select().from(nightManifests)).length); },
      onSend: async () => { atSend = await nightsOf(shift.id); },
    });
    const { deps } = makeDeps(db, { attestRoot: realAttestRoot, signer });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 5, txHash: HASH_OF_SIGNED });
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(atSign).toEqual([1]); // the manifest URI resolves before the tx can land

    // what was signed: one attest under the root schema, carrying the root every row proves into
    const data = (signTransaction.mock.calls[0][0] as { data: Hex }).data;
    const call = decodeFunctionData({ abi: easAbi, data });
    expect(call.functionName).toBe('attest');
    const req = (call.args as unknown as [{ schema: Hex; data: { data: Hex } }])[0];
    expect(req.schema).toBe(rootSchemaUid());
    const signedRoot = decodeRoot(req.data.data);
    expect(signedRoot).toMatchObject({ night: 20261106, count: 5, agentId: 42n });

    // at send time every row already held the tx and its proof into that root
    expect(atSend.every((n) => n.attestTx === HASH_OF_SIGNED && n.attestRoot === signedRoot.root && proven(n) && !n.attestationUid)).toBe(true);
    const manifestHash = signedRoot.manifestURI.split('/').pop()!;
    expect(atSend.every((n) => n.attestManifest === manifestHash)).toBe(true);
    expect((await getNightManifest(db, manifestHash))?.root).toBe(signedRoot.root);

    const rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestationUid === ROOT_UID && n.attestTx === HASH_OF_SIGNED && n.attestRoot === signedRoot.root && proven(n))).toBe(true);
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attested', attestTxs: [HASH_OF_SIGNED] });
  });

  it('send fails after the persist -> claim kept with attest_tx + nonce + sender + proofs, no release, no gas refund', async () => {
    const { shift } = await shiftWithNights(2);
    const { signer, sendRawTransaction } = fakeSigner({ sendErr: Object.assign(new Error('already known'), { name: 'TimeoutError' }) });
    const release = vi.fn(async () => undefined);
    const { deps } = makeDeps(db, { attestRoot: realAttestRoot, signer, release });
    expect(await finalizeShift(shift.id, deps)).toMatchObject({ attested: 0, skipped: 'unconfirmed' });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    const rows = await nightsOf(shift.id);
    expect(rows.every((n) => n.attestClaimedAt !== null && n.attestTx === HASH_OF_SIGNED && n.attestNonce === 11 && n.attestSender === SENDER && proven(n)))
      .toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'unconfirmed:timeout' });

    // the next pass checks that tx against its recorded nonce and sender, and sends nothing new while it may mine
    const attestReceipt = vi.fn(async () => ({ status: 'pending' as const }));
    const later = makeDeps(db, { attestRoot: realAttestRoot, signer, attestReceipt });
    expect(await finalizeShift(shift.id, later.deps)).toEqual({ attested: 0 });
    expect(attestReceipt).toHaveBeenCalledWith(HASH_OF_SIGNED, 11, SENDER);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);

    // it mines after all: the one root uid lands on both rows, with the proofs written before the send
    const mined = makeDeps(db, { attestRoot: realAttestRoot, signer, attestReceipt: vi.fn(async () => ({ status: 'success' as const, uids: [ROOT_UID] })) });
    expect(await finalizeShift(shift.id, mined.deps)).toEqual({ attested: 2, txHash: HASH_OF_SIGNED });
    expect((await nightsOf(shift.id)).every((n) => n.attestationUid === ROOT_UID && proven(n))).toBe(true);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  /** 1.2 x 200k gas x (2 x baseFee 0.001 gwei + tip 0.001 gwei): what one send reserves with fakeSigner. */
  const RESERVED = 240_000n * 3_000_000n;

  it('a persist that misses a row (its claim token changed under the batch) sends nothing: gas refunded, our rows released', async () => {
    const { shift } = await shiftWithNights(2);
    const { signer, sendRawTransaction } = fakeSigner({
      onSign: async () => {
        const [firstRow] = await nightsOf(shift.id);
        await db.update(nights).set({ attestClaimId: 'someone-else' }).where(eq(nights.id, firstRow.id));
      },
    });
    const release = vi.fn(async () => undefined);
    const { deps } = makeDeps(db, { attestRoot: realAttestRoot, signer, release });
    expect(await finalizeShift(shift.id, deps)).toEqual({ attested: 0, skipped: 'error' });
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('gas_wei', RESERVED);
    const rows = await nightsOf(shift.id);
    expect(rows[0]).toMatchObject({ attestClaimId: 'someone-else', attestTx: null, attestationUid: null, attestRoot: null }); // not ours: untouched
    expect(rows[1]).toMatchObject({
      attestClaimId: null, attestClaimedAt: null, attestTx: null, attestNonce: null, attestSentAt: null, attestRoot: null, attestProof: null,
    });
    expect(await getShift(db, shift.id)).toMatchObject({ status: 'attest_pending', notes: 'skipped:error:persist_failed' });
  });

  it('the old claimant of a taken-over claim: its late persist writes 0 rows and throws, so it never sends', async () => {
    const { shift } = await shiftWithNights(2);
    const signing = deferred();
    const resume = deferred();
    const { signer, sendRawTransaction } = fakeSigner({ onSign: async () => { signing.resolve(); await resume.promise; } });
    const release = vi.fn(async () => undefined);
    const slow = makeDeps(db, { attestRoot: realAttestRoot, signer, release }); // claims at NOW
    const a = finalizeShift(shift.id, slow.deps);
    await signing.promise; // the slow pass holds a tx-less claim and is about to persist
    const ids = (await nightsOf(shift.id)).map((n) => n.id);
    const t1 = (await nightsOf(shift.id))[0].attestClaimId!;

    const b = makeDeps(db);
    b.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    expect(await finalizeShift(shift.id, b.deps)).toEqual({ attested: 2, txHash: TX }); // took over and sent once
    const late: NightProofBatch = { root: HASH(900), manifest: HASH(901), rows: ids.map((id) => ({ id, leaf: HASH(900), proof: [], lit30: 0 })) };
    expect(await markNightsBroadcast(db, late, t1, HASH_OF_SIGNED, 11, SENDER, NOW)).toBe(0); // what the late persist sees

    resume.resolve();
    expect(await a).toEqual({ attested: 0, skipped: 'error' });
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('gas_wei', RESERVED); // the slow pass refunded its reservation
    expect(b.deps.attestRoot).toHaveBeenCalledTimes(1);
    const rows = await nightsOf(shift.id);
    expect(rows.map((n) => n.attestationUid)).toEqual([uidOf(1), uidOf(1)]);
    expect(rows.every((n) => n.attestTx === TX && n.attestClaimId !== t1 && proven(n))).toBe(true);
    expect((await getShift(db, shift.id))?.status).toBe('attested');
  });
});
