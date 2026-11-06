import { keccak256, toBytes, type Hex } from 'viem';
import {
  DuplicateNight, claimShiftFinalization, claimShiftNights, countUnattested, getNightsForProjects, getProjectsByIds,
  getShift, insertNight, leaseStaleShift, listProjects, listStaleShifts, listUnconfirmedBroadcasts, markNightsBroadcast,
  releaseNightClaims, saveEvidence, setNightAttestations, updateShift,
} from '@/lib/db/queries';
import type { NightRow, ShiftRow } from '@/lib/db/schema';
import type { NightAttestation } from '@/lib/attest/eas';
import { safeErrorCode } from '@/lib/net/redact';
import { STATUS_CODE, type EvidenceBundle, type Kind, type Status } from '@/lib/types';
import { computeRecord, decideStatus } from './rules';
import { hashEvidence, RULES_VERSION } from './evidence';
import { attestDepsFor, canAttest, receiptOf, siteUrlOf, type ShiftDeps } from './deps';
import { nightDate, nightNumber, nightOf, nightlyWindow, shiftStartOfNight } from './night';

export const ATTEST_BATCH = 20;
export const STALE_AFTER_MS = 45 * 60_000;
/** A broadcast tx whose receipt is still missing this long after the claim is treated as dropped. */
export const DROPPED_AFTER_MS = 30 * 60_000;
/** Wall-clock bound of one stale pass (no new shift or batch is started after it). */
export const STALE_PASS_MS = 60_000;
const MISSING_SUMMARY = 'The check for this project did not complete in this shift, so no claim is made either way.';

export interface FinalizeOptions {
  /** Wall-clock deadline (ms, per `clock`): no new receipt check or batch starts after it. */
  deadline?: number;
  clock?: () => number;
}
export interface FinalizeResult { attested: number; txHash?: Hex; skipped?: string }

export function toAttestation(
  p: { slug: string; night: number; kind: Kind; status: Status; lit30: number; evidenceHash: Hex },
  deps: Pick<ShiftDeps, 'agentId' | 'siteUrl'>,
): NightAttestation {
  return {
    projectKey: keccak256(toBytes(p.slug)),
    night: p.night,
    kind: p.kind === 'nightly' ? 0 : 1,
    status: STATUS_CODE[p.status],
    lit30: Math.min(Math.max(0, p.lit30), 65_535),
    evidenceHash: p.evidenceHash,
    agentId: deps.agentId ?? 0n,
    evidenceURI: `${siteUrlOf(deps)}/api/v1/evidence/${p.evidenceHash}`,
  };
}

/** First night (yyyy-mm-dd) of the 30-night window ending at `night`, with a day of slack. */
export function lit30From(night: number): string {
  const t = shiftStartOfNight(nightDate(night)).getTime() - 31 * 86_400_000;
  return nightDate(nightNumber(new Date(t)));
}

/** lit30 over a project's stored nights (observed and reconstructed; rows must be ordered so observed comes last). */
export function lit30Of(rows: Pick<NightRow, 'night' | 'status'>[], night: number): number {
  return computeRecord(rows.map((r) => ({ night: nightOf(r.night), status: r.status })), night).lit30;
}

/** Every project planned for the shift gets a night row: a run that never reported back is `unavailable`. */
async function fillMissingNights(shift: ShiftRow, deps: ShiftDeps): Promise<void> {
  const { db } = deps;
  const planned = (await listProjects(db)).filter((p) => p.createdAt.getTime() <= shift.startedAt.getTime());
  if (planned.length === 0) return;
  const have = new Set(
    (await getNightsForProjects(db, planned.map((p) => p.id), shift.night))
      .filter((n) => n.night === shift.night && n.observed)
      .map((n) => n.projectId),
  );
  const night = nightOf(shift.night);
  const window = nightlyWindow(shiftStartOfNight(shift.night));
  for (const p of planned) {
    if (have.has(p.id)) continue;
    const bundle: EvidenceBundle = {
      v: 1, rulesVersion: RULES_VERSION, project: p.slug, night, kind: 'nightly', window,
      sources: { repo: null, liveapp: null, chain: null, vibestarter: null },
    };
    const decision = decideStatus(bundle);
    const hash = hashEvidence(bundle);
    await saveEvidence(db, hash, p.id, shift.night, bundle);
    try {
      await insertNight(db, {
        projectId: p.id, night: shift.night, shiftId: shift.id, status: decision.status, observed: true,
        signals: { reasons: decision.reasons, missing: true }, summary: MISSING_SUMMARY, notable: [],
        evidenceHash: hash, aiModel: null, aiOk: false,
      });
    } catch (e) {
      if (!(e instanceof DuplicateNight)) throw e; // a late run got there first: keep its row
    }
  }
}

/**
 * Settle batches that were broadcast but never confirmed (claimed rows with attest_tx, no uid). Mined: uids from the
 * EAS `Attested` logs, mapped onto the rows in batch order (id ascending, the order they were sent). Confirmed revert,
 * or no receipt 30 min after the claim (dropped): release the rows. Anything else (pending, RPC error, count
 * mismatch): leave them claimed, so they are never sent twice.
 */
async function reconcileBroadcasts(shift: ShiftRow, deps: ShiftDeps, o: Required<FinalizeOptions>): Promise<{ attested: number; tx?: Hex }> {
  const rows = await listUnconfirmedBroadcasts(deps.db, shift.id);
  const receipt = receiptOf(deps);
  if (rows.length === 0 || !receipt) return { attested: 0 };
  const byTx = new Map<string, NightRow[]>();
  for (const r of rows) byTx.set(r.attestTx!, [...(byTx.get(r.attestTx!) ?? []), r]);
  let attested = 0;
  let last: Hex | undefined;
  for (const [tx, batch] of byTx) {
    if (o.clock() > o.deadline) break;
    const ids = batch.map((r) => r.id);
    const rc = await receipt(tx as Hex).catch((e) => ({ status: 'error' as const, error: safeErrorCode(e) }));
    if (rc.status === 'success') {
      if (rc.uids.length !== batch.length) {
        console.error('shift.reconcile: uid count mismatch for a mined batch; rows left claimed');
        continue;
      }
      await setNightAttestations(deps.db, batch.map((r, i) => ({ id: r.id, uid: rc.uids[i] })), tx);
      attested += batch.length;
      last = tx as Hex;
    } else if (rc.status === 'reverted') {
      await releaseNightClaims(deps.db, ids);
    } else if (rc.status === 'not_found') {
      const claimedAt = Math.min(...batch.map((r) => r.attestClaimedAt!.getTime()));
      if (deps.now().getTime() - claimedAt > DROPPED_AFTER_MS) await releaseNightClaims(deps.db, ids);
    }
  }
  return { attested, ...(last ? { tx: last } : {}) };
}

/**
 * Close a nightly shift. Safe to call repeatedly and concurrently:
 *   1. reconcile batches broadcast earlier but never confirmed;
 *   2. fill missing nights (`unavailable`);
 *   3. claim unattested rows atomically (each row reaches exactly one caller) and send them with multiAttest in
 *      batches of 20 (id order). A batch that was never broadcast, or that reverted, is released for a retry; a
 *      broadcast batch with an unknown outcome keeps its claim and its tx, for step 1 of a later pass;
 *   4. status `attested` / `attest_pending` (also after any throw), then the finalization claim: onFinalized fires
 *      once, from the call that first closed the shift, after the attestation writes.
 */
export async function finalizeShift(shiftId: number, deps: ShiftDeps, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  const { db } = deps;
  const o: Required<FinalizeOptions> = { clock: opts.clock ?? Date.now, deadline: opts.deadline ?? Number.POSITIVE_INFINITY };
  const shift = await getShift(db, shiftId);
  if (!shift || shift.kind !== 'nightly') return { attested: 0, skipped: 'not_found' };

  let attested = 0;
  let txHash: Hex | undefined;
  let skipped: string | undefined;
  let note: string | null = null;
  const txs: string[] = [];
  const unsent = new Set<number>(); // claimed by us, never handed to attestMany: always safe to release
  let inflight: { ids: number[]; tx?: Hex } | null = null; // handed to attestMany: release only on proof

  try {
    const rec = await reconcileBroadcasts(shift, deps, o);
    attested += rec.attested;
    if (rec.tx) { txHash = rec.tx; txs.push(rec.tx); }
    await fillMissingNights(shift, deps);

    if (!canAttest(deps)) {
      skipped = 'disabled';
      note = 'skipped:disabled';
    } else {
      const claimed = (await claimShiftNights(db, shiftId, deps.now())).sort((a, b) => a.id - b.id);
      claimed.forEach((r) => unsent.add(r.id));
      if (claimed.length > 0) {
        const ids = [...new Set(claimed.map((r) => r.projectId))];
        const slugs = new Map((await getProjectsByIds(db, ids)).map((p) => [p.id, p.slug]));
        const history = await getNightsForProjects(db, ids, lit30From(nightOf(shift.night)));
        const atts = claimed.map((row) => toAttestation({
          slug: slugs.get(row.projectId) ?? String(row.projectId),
          night: nightOf(row.night),
          kind: 'nightly',
          status: row.status,
          lit30: lit30Of(history.filter((h) => h.projectId === row.projectId), nightOf(row.night)),
          evidenceHash: row.evidenceHash as Hex,
        }, deps));

        for (let i = 0; i < claimed.length; i += ATTEST_BATCH) {
          if (o.clock() > o.deadline) {
            skipped = 'deadline';
            note = 'skipped:deadline';
            break;
          }
          const batchIds = claimed.slice(i, i + ATTEST_BATCH).map((r) => r.id);
          const flight: { ids: number[]; tx?: Hex } = { ids: batchIds };
          inflight = flight;
          batchIds.forEach((id) => unsent.delete(id));
          const onBroadcast = async (h: Hex) => {
            flight.tx = h;
            await markNightsBroadcast(db, batchIds, h);
          };
          let r: Awaited<ReturnType<ShiftDeps['attestMany']>>;
          try {
            r = await deps.attestMany(atts.slice(i, i + ATTEST_BATCH), attestDepsFor(deps, onBroadcast));
          } catch (e) {
            r = { skipped: 'error', error: safeErrorCode(e), ...(flight.tx ? { txHash: flight.tx } : {}) };
            if (!flight.tx) {
              // Unknown whether it was sent: keep the claim (never risk a second attestation).
              skipped = 'unconfirmed';
              note = 'unconfirmed:unknown';
              break;
            }
          }
          if ('skipped' in r) {
            const tx = r.txHash ?? flight.tx;
            if (tx && r.error !== 'reverted') {
              // Broadcast, outcome unknown: keep the claim + tx; a later pass settles it from the receipt.
              flight.tx = tx;
              await markNightsBroadcast(db, batchIds, tx);
              skipped = 'unconfirmed';
              note = `unconfirmed:${r.error ?? 'error'}`;
            } else {
              // Never broadcast, or a confirmed revert: nothing is on chain for these rows.
              await releaseNightClaims(db, batchIds);
              skipped = r.skipped;
              note = `skipped:${r.skipped}${r.error ? `:${r.error}` : ''}`;
            }
            inflight = null;
            break;
          }
          flight.tx = r.txHash;
          await setNightAttestations(db, batchIds.map((id, k) => ({ id, uid: r.uids[k] })), r.txHash);
          inflight = null;
          attested += batchIds.length;
          txHash = r.txHash;
          txs.push(r.txHash);
        }
      }
    }
  } catch (e) {
    skipped ??= 'error';
    note ??= `skipped:error:${safeErrorCode(e)}`;
    console.error('shift.finalize failed:', safeErrorCode(e));
    const f = inflight as { ids: number[]; tx?: Hex } | null;
    if (f?.tx) await markNightsBroadcast(db, f.ids, f.tx).catch(() => undefined);
  } finally {
    // Rows never handed to attestMany go back for a retry (a no-op once they are attested).
    if (unsent.size) await releaseNightClaims(db, [...unsent]).catch(() => undefined);
  }

  let first = false;
  try {
    const pending = await countUnattested(db, shiftId);
    first = await claimShiftFinalization(db, shiftId, deps.now());
    await updateShift(db, shiftId, {
      status: pending === 0 ? 'attested' : 'attest_pending',
      notes: pending === 0 ? null : note ?? shift.notes,
      finishedAt: deps.now(),
      ...(txs.length ? { attestTx: [shift.attestTx, ...txs].filter(Boolean).join(',') } : {}),
    });
  } catch (e) {
    console.error('shift.finalize status failed:', safeErrorCode(e));
    await updateShift(db, shiftId, { status: 'attest_pending' }).catch(() => undefined);
  }

  if (first && deps.onFinalized) {
    try { await deps.onFinalized(shiftId); } catch (e) { console.error('shift.onFinalized failed:', safeErrorCode(e)); }
  }
  return { attested, ...(txHash ? { txHash } : {}), ...(skipped ? { skipped } : {}) };
}

/**
 * Finalize nightly shifts stuck > 45 min (never finished, `attest_pending`, or left `running`), retried every 45 min
 * for 48 h. A finished shift is leased first, so concurrent passes do not repeat its work. Bounded to `maxMs` of wall
 * clock: no new shift or batch starts after that.
 */
export async function maybeFinalizeStale(
  deps: ShiftDeps, opts: { maxMs?: number; clock?: () => number } = {},
): Promise<number> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.maxMs ?? STALE_PASS_MS);
  const now = deps.now();
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = await listStaleShifts(deps.db, now, STALE_AFTER_MS);
  let n = 0;
  for (const s of stale) {
    if (clock() > deadline) break;
    try {
      if (s.finishedAt && !(await leaseStaleShift(deps.db, s.id, now, cutoff))) continue;
      await finalizeShift(s.id, deps, { deadline, clock });
      n++;
    } catch (e) {
      console.error('shift.finalize failed:', safeErrorCode(e));
    }
  }
  return n;
}
