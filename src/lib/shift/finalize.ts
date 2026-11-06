import { randomUUID } from 'node:crypto';
import { keccak256, toBytes, type Hex } from 'viem';
import {
  DuplicateNight, claimShiftFinalization, claimShiftNights, countUnattested, getNightsForProjects, getProjectsByIds,
  getShift, insertNight, leaseShift, listProjects, listStaleShifts, listUnconfirmedBroadcasts, markNightsBroadcast,
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

/** Rows per claim and per multiAttest: a killed pass strands at most one batch. */
export const ATTEST_BATCH = 20;
export const STALE_AFTER_MS = 45 * 60_000;
/** Wall-clock bound of one stale pass (no new shift or batch is started after it). */
export const STALE_PASS_MS = 60_000;
/** One stale pass per shift at a time; outlives a bounded pass plus one receipt wait. */
export const STALE_LEASE_MS = 5 * 60_000;
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
 * Settle batches that were broadcast but never confirmed (rows held under a claim token with attest_tx, no uid), one
 * group per (claim token, tx). Mined: uids from the EAS `Attested` logs, mapped onto the rows in batch order (id
 * ascending, the order they were sent). Confirmed revert, or dropped (no receipt and a later tx consumed its nonce):
 * release the rows. Pending, RPC error or count mismatch: leave them claimed, so they are never sent twice.
 * Every write presents the group's claim token AND tx, so a slower concurrent reconciler can never touch rows that
 * were released and re-claimed in the meantime.
 */
async function reconcileBroadcasts(shift: ShiftRow, deps: ShiftDeps, o: Required<FinalizeOptions>): Promise<{ attested: number; tx?: Hex }> {
  const rows = await listUnconfirmedBroadcasts(deps.db, shift.id);
  const receipt = receiptOf(deps);
  if (rows.length === 0 || !receipt) return { attested: 0 };
  const groups = new Map<string, NightRow[]>();
  for (const r of rows) {
    const key = `${r.attestClaimId}|${r.attestTx}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let attested = 0;
  let last: Hex | undefined;
  for (const batch of groups.values()) {
    if (o.clock() > o.deadline) break;
    const claimId = batch[0].attestClaimId!;
    const tx = batch[0].attestTx! as Hex;
    const nonce = batch[0].attestNonce ?? null;
    const ids = batch.map((r) => r.id);
    const rc = await receipt(tx, nonce).catch((e) => ({ status: 'error' as const, error: safeErrorCode(e) }));
    if (rc.status === 'success') {
      if (rc.uids.length !== batch.length) {
        console.error('shift.reconcile: uid count mismatch for a mined batch; rows left claimed');
        continue;
      }
      await setNightAttestations(deps.db, batch.map((r, i) => ({ id: r.id, uid: rc.uids[i] })), tx, claimId);
      attested += batch.length;
      last = tx;
    } else if (rc.status === 'reverted' || rc.status === 'dropped') {
      await releaseNightClaims(deps.db, ids, claimId, tx);
    }
  }
  return { attested, ...(last ? { tx: last } : {}) };
}

async function attestationsFor(rows: NightRow[], shift: ShiftRow, deps: ShiftDeps): Promise<NightAttestation[]> {
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const slugs = new Map((await getProjectsByIds(deps.db, ids)).map((p) => [p.id, p.slug]));
  const history = await getNightsForProjects(deps.db, ids, lit30From(nightOf(shift.night)));
  return rows.map((row) => toAttestation({
    slug: slugs.get(row.projectId) ?? String(row.projectId),
    night: nightOf(row.night),
    kind: 'nightly',
    status: row.status,
    lit30: lit30Of(history.filter((h) => h.projectId === row.projectId), nightOf(row.night)),
    evidenceHash: row.evidenceHash as Hex,
  }, deps));
}

/**
 * Close a nightly shift. Safe to call repeatedly and concurrently:
 *   1. reconcile batches broadcast earlier but never confirmed;
 *   2. fill missing nights (`unavailable`);
 *   3. loop: claim <= 20 unattested rows under a fresh claim token (each row reaches exactly one caller), send them
 *      with one multiAttest. A batch that was never broadcast, or that reverted, is released for a retry; a broadcast
 *      batch with an unknown outcome keeps its claim, tx and nonce, for step 1 of a later pass, and the loop stops;
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
  /** Claimed by us and never handed to attestMany: always safe to release (under our token). */
  const unsent: { ids: number[]; claimId: string }[] = [];
  /** Handed to attestMany: released only on proof that nothing is on chain. */
  let inflight: { ids: number[]; claimId: string; tx?: Hex; nonce?: number } | null = null;

  try {
    const rec = await reconcileBroadcasts(shift, deps, o);
    attested += rec.attested;
    if (rec.tx) { txHash = rec.tx; txs.push(rec.tx); }
    await fillMissingNights(shift, deps);

    if (!canAttest(deps)) {
      skipped = 'disabled';
      note = 'skipped:disabled';
    } else {
      for (;;) {
        if (o.clock() > o.deadline) {
          skipped = 'deadline';
          note = 'skipped:deadline';
          break;
        }
        const claimId = randomUUID();
        const rows = await claimShiftNights(db, shiftId, deps.now(), claimId, ATTEST_BATCH);
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id);
        const held = { ids, claimId };
        unsent.push(held);
        const atts = await attestationsFor(rows, shift, deps);
        unsent.splice(unsent.indexOf(held), 1);

        const flight: { ids: number[]; claimId: string; tx?: Hex; nonce?: number } = { ids, claimId };
        inflight = flight;
        const onBroadcast = async (h: Hex, nonce: number) => {
          flight.tx = h;
          flight.nonce = nonce;
          await markNightsBroadcast(db, ids, claimId, h, nonce);
        };
        let r: Awaited<ReturnType<ShiftDeps['attestMany']>>;
        try {
          r = await deps.attestMany(atts, attestDepsFor(deps, onBroadcast));
        } catch (e) {
          if (!flight.tx) {
            // Unknown whether it was sent: keep the claim (never risk a second attestation).
            skipped = 'unconfirmed';
            note = 'unconfirmed:unknown';
            inflight = null;
            break;
          }
          r = { skipped: 'error', error: safeErrorCode(e), txHash: flight.tx, ...(flight.nonce !== undefined ? { nonce: flight.nonce } : {}) };
        }
        if ('skipped' in r) {
          const tx = r.txHash ?? flight.tx;
          if (tx && r.error !== 'reverted') {
            // Broadcast, outcome unknown: keep claim + tx + nonce; a later pass settles it from the receipt.
            flight.tx = tx;
            await markNightsBroadcast(db, ids, claimId, tx, r.nonce ?? flight.nonce ?? null);
            skipped = 'unconfirmed';
            note = `unconfirmed:${r.error ?? 'error'}`;
          } else {
            // Never broadcast, or a confirmed revert: nothing is on chain for these rows.
            try {
              await releaseNightClaims(db, ids, claimId);
            } catch (e) {
              unsent.push(held); // retried in finally
              throw e;
            }
            skipped = r.skipped;
            note = `skipped:${r.skipped}${r.error ? `:${r.error}` : ''}`;
          }
          inflight = null;
          break;
        }
        flight.tx = r.txHash;
        await setNightAttestations(db, ids.map((id, k) => ({ id, uid: r.uids[k] })), r.txHash, claimId);
        inflight = null;
        attested += ids.length;
        txHash = r.txHash;
        txs.push(r.txHash);
      }
    }
  } catch (e) {
    skipped ??= 'error';
    note ??= `skipped:error:${safeErrorCode(e)}`;
    console.error('shift.finalize failed:', safeErrorCode(e));
    const f = inflight as { ids: number[]; claimId: string; tx?: Hex; nonce?: number } | null;
    if (f?.tx) await markNightsBroadcast(db, f.ids, f.claimId, f.tx, f.nonce ?? null).catch(() => undefined);
  } finally {
    for (const u of unsent) await releaseNightClaims(db, u.ids, u.claimId).catch(() => undefined);
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
 * for 48 h. Each shift is leased (single statement) before work, so two passes never work the same shift at once.
 * Bounded to `maxMs` of wall clock: no new shift or batch starts after that.
 */
export async function maybeFinalizeStale(
  deps: ShiftDeps, opts: { maxMs?: number; clock?: () => number } = {},
): Promise<number> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.maxMs ?? STALE_PASS_MS);
  const now = deps.now();
  const stale = await listStaleShifts(deps.db, now, STALE_AFTER_MS);
  let n = 0;
  for (const s of stale) {
    if (clock() > deadline) break;
    try {
      if (!(await leaseShift(deps.db, s.id, now, STALE_LEASE_MS))) continue;
      await finalizeShift(s.id, deps, { deadline, clock });
      n++;
    } catch (e) {
      console.error('shift.finalize failed:', safeErrorCode(e));
    }
  }
  return n;
}
