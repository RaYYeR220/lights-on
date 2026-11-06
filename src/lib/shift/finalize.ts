import { randomUUID } from 'node:crypto';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import {
  DuplicateNight, appendShiftTxs, claimShiftFinalization, claimShiftNights, countUnattested, getNightsForProjects, getProjectsByIds,
  getShift, insertNight, leaseShift, listProjects, listStaleShifts, listUnconfirmedBroadcasts, markNightsBroadcast,
  releaseNightClaims, saveEvidence, saveNightManifest, setNightAttestations, updateShift, type NightProofBatch,
} from '@/lib/db/queries';
import type { NightRow, ShiftRow } from '@/lib/db/schema';
import type { NightAttestation, NightRoot } from '@/lib/attest/eas';
import { buildNightManifest, clampLit30, type BuiltManifest } from '@/lib/attest/manifest';
import { verifyProof } from '@/lib/attest/merkle';
import { safeErrorCode } from '@/lib/net/redact';
import { STATUS_CODE, type EvidenceBundle, type Kind, type Status } from '@/lib/types';
import { computeRecord, decideStatus } from './rules';
import { hashEvidence, RULES_VERSION } from './evidence';
import { attestDepsFor, canAttest, receiptOf, siteUrlOf, type ShiftDeps } from './deps';
import { nightDate, nightNumber, nightOf, nightlyWindow, shiftStartOfNight } from './night';

/**
 * Rows per claim and per root attestation: a shift of up to 500 nights is exactly one tx, and a killed pass strands at
 * most one batch.
 */
export const ATTEST_BATCH = 500;
export const STALE_AFTER_MS = 45 * 60_000;
/** Wall-clock bound of one stale pass (no new shift or batch is started after it). */
export const STALE_PASS_MS = 60_000;
/** One stale pass per shift at a time; outlives a bounded pass plus one receipt wait. */
export const STALE_LEASE_MS = 5 * 60_000;
/**
 * A `dropped` verdict is acted on only once the tx was first persisted this long ago: a lagging replica of a
 * load-balanced RPC may not know a fresh tx yet. A younger "dropped" tx stays pending.
 */
export const DROP_AFTER_MS = 10 * 60_000;
const MISSING_SUMMARY = 'The check for this project did not complete in this shift, so no claim is made either way.';

export interface FinalizeOptions {
  /** Wall-clock deadline (ms, per `clock`): no new receipt check or batch starts after it. */
  deadline?: number;
  clock?: () => number;
}
export interface FinalizeResult { attested: number; txHash?: Hex; skipped?: string }
/** A batch handed to attestRoot; tx/nonce/sender are set once the signed tx (with the batch's proofs) is persisted. */
interface Flight { ids: number[]; claimId: string; batch: NightProofBatch; tx?: Hex; nonce?: number; sender?: Address }

export function toAttestation(
  p: { slug: string; night: number; kind: Kind; status: Status; lit30: number; evidenceHash: Hex },
  deps: Pick<ShiftDeps, 'agentId' | 'siteUrl'>,
): NightAttestation {
  return {
    projectKey: keccak256(toBytes(p.slug)),
    night: p.night,
    kind: p.kind === 'nightly' ? 0 : 1,
    status: STATUS_CODE[p.status],
    lit30: clampLit30(p.lit30),
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

/** When the batch's tx was first persisted (legacy rows: claim time); unknown -> never old enough. */
function persistedAt(batch: NightRow[]): number {
  return Math.max(...batch.map((r) => (r.attestSentAt ?? r.attestClaimedAt)?.getTime() ?? Number.POSITIVE_INFINITY));
}

/**
 * The Merkle fields a broadcast batch persisted with its tx (before the send), if they check out: one root and one
 * manifest across the group, and every row's proof leading from its leaf to that root. Null otherwise.
 */
function storedBatch(rows: NightRow[]): NightProofBatch | null {
  const root = rows[0]?.attestRoot;
  const manifest = rows[0]?.attestManifest;
  if (!root || !manifest) return null;
  const out: NightProofBatch['rows'] = [];
  for (const r of rows) {
    if (r.attestRoot !== root || r.attestManifest !== manifest || !r.attestLeaf || !r.attestProof || r.attestLit30 === null) return null;
    if (!verifyProof(r.attestLeaf as Hex, r.attestProof as Hex[], root as Hex)) return null;
    out.push({ id: r.id, leaf: r.attestLeaf, proof: r.attestProof, lit30: r.attestLit30 });
  }
  return { root, manifest, rows: out };
}

/**
 * Settle batches that were broadcast but never confirmed (rows held under a claim token with attest_tx, no uid), one
 * group per (claim token, tx). Mined: the tx's single EAS `Attested` uid (the root attestation) is written to every row
 * of the group, with the proofs persisted before the send. Confirmed revert, or dropped (no receipt, a later tx
 * consumed its nonce, and the tx was persisted >= DROP_AFTER_MS ago): release the rows. Pending, a younger dropped,
 * RPC error, a uid count other than 1, or stored proofs that do not check out: leave them claimed, so they are never
 * sent twice.
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
    const sender = (batch[0].attestSender ?? null) as Address | null;
    const ids = batch.map((r) => r.id);
    const rc = await receipt(tx, nonce, sender).catch((e) => ({ status: 'error' as const, error: safeErrorCode(e) }));
    if (rc.status === 'success') {
      const stored = storedBatch(batch);
      if (rc.uids.length !== 1 || !stored) {
        console.error(`shift.reconcile: a mined root batch does not check out (${rc.uids.length !== 1 ? 'uid count' : 'stored proofs'}); rows left claimed`);
        continue;
      }
      attested += await setNightAttestations(deps.db, stored, rc.uids[0], tx, claimId);
      last = tx;
    } else if (rc.status === 'reverted' || (rc.status === 'dropped' && deps.now().getTime() - persistedAt(batch) >= DROP_AFTER_MS)) {
      await releaseNightClaims(deps.db, ids, claimId, tx);
    }
  }
  return { attested, ...(last ? { tx: last } : {}) };
}

/** One batch's root attestation: the manifest (with its tree), the per-row proof data, and the NightRoot to sign. */
interface RootPlan { built: BuiltManifest; batch: NightProofBatch; root: NightRoot }

async function rootFor(rows: NightRow[], shift: ShiftRow, deps: ShiftDeps): Promise<RootPlan> {
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const byId = new Map((await getProjectsByIds(deps.db, ids)).map((p) => [p.id, p]));
  const history = await getNightsForProjects(deps.db, ids, lit30From(nightOf(shift.night)));
  const agentId = deps.agentId ?? 0n;
  const built = buildNightManifest(rows.map((row) => {
    const p = byId.get(row.projectId);
    // The projectKey is keccak256(slug): a row whose project cannot be read is never attested under a made-up key.
    // Thrown while the batch is still `unsent`, so it is released and retried by a later pass.
    if (!p) throw new Error('project_missing');
    return {
      slug: p.slug,
      // community-added and hidden projects are unlisted: their slug stays out of the public manifest
      listed: !p.hidden && p.source !== 'community',
      night: nightOf(row.night),
    status: row.status,
      lit30: lit30Of(history.filter((h) => h.projectId === row.projectId), nightOf(row.night)),
      evidenceHash: row.evidenceHash as Hex,
    };
  }), agentId);
  const batch: NightProofBatch = {
    root: built.root,
    manifest: built.hash,
    rows: rows.map((row, i) => {
      const l = built.inOrder[i];
      return { id: row.id, leaf: l.leaf, proof: built.proofs.get(l.leaf)!, lit30: l.lit30 };
    }),
  };
  return {
    built,
    batch,
    root: {
      root: built.root, night: built.manifest.night, count: rows.length, agentId,
      manifestURI: `${siteUrlOf(deps)}/api/v1/manifest/${built.hash}`,
    },
  };
}

/**
 * Close a nightly shift. Safe to call repeatedly and concurrently:
 *   1. reconcile batches broadcast earlier but never confirmed;
 *   2. fill missing nights (`unavailable`);
 *   3. loop: claim <= 500 unattested rows under a fresh claim token (each row reaches exactly one caller; a tx-less
 *      claim older than 10 min is taken over in the same statement), build their Merkle tree and store the night
 *      manifest, then attest the ROOT with one `attest`. The signed hash is persisted under the token, in the same
 *      statement as every row's leaf and proof, before the send, and the send goes ahead only if every row of the
 *      batch was still ours. A batch that was never broadcast, or that reverted, is released for a retry; a
 *      broadcast batch with an unknown outcome keeps its claim, tx, nonce, sender and proofs (persisted before the
 *      send), for step 1 of a later pass, and the loop stops;
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
  /** Claimed by us and never handed to attestRoot: always safe to release (under our token). */
  const unsent: { ids: number[]; claimId: string }[] = [];
  /** Handed to attestRoot: released only on proof that nothing is on chain. */
  let inflight: Flight | null = null;

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
        const rows = await claimShiftNights(db, shiftId, deps.now(), claimId, deps.attestBatch ?? ATTEST_BATCH);
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id);
        const held = { ids, claimId };
        unsent.push(held);
        const plan = await rootFor(rows, shift, deps);
        // Stored BEFORE anything is signed: the manifestURI resolves the moment the root lands on chain.
        await saveNightManifest(db, plan.built.hash, shift.night, plan.built.root, plan.built.manifest);
        unsent.splice(unsent.indexOf(held), 1);

        const flight: Flight = { ids, claimId, batch: plan.batch };
        inflight = flight;
        // Runs after signing and BEFORE the raw tx is sent, writing the tx and every row's proof in one statement: if
        // this write fails, or misses any row of the batch (its claim was taken over), it throws and nothing is sent;
        // the rows still held are then released below.
        const onBroadcast = async (h: Hex, nonce: number, sender: Address) => {
          const written = await markNightsBroadcast(db, plan.batch, claimId, h, nonce, sender, deps.now());
          if (written !== ids.length) throw new Error('claim_lost');
          flight.tx = h;
          flight.nonce = nonce;
          flight.sender = sender;
        };
        let r: Awaited<ReturnType<ShiftDeps['attestRoot']>>;
        try {
          r = await deps.attestRoot(plan.root, attestDepsFor(deps, onBroadcast));
        } catch (e) {
          if (!flight.tx) {
            // No tx was persisted, so nothing was sent (send() persists before it sends). Keep the claim anyway:
            // the next claim takes it over once it is 10 min old, and a late persist from this pass then fails.
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
            // Broadcast, outcome unknown: keep claim + tx + nonce + proofs; a later pass settles it from the receipt.
            flight.tx = tx;
            await markNightsBroadcast(db, plan.batch, claimId, tx, r.nonce ?? flight.nonce ?? null, flight.sender ?? null, deps.now());
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
        attested += await setNightAttestations(db, plan.batch, r.uid, r.txHash, claimId);
        inflight = null;
        txHash = r.txHash;
        txs.push(r.txHash);
      }
    }
  } catch (e) {
    skipped ??= 'error';
    note ??= `skipped:error:${safeErrorCode(e)}`;
    console.error('shift.finalize failed:', safeErrorCode(e));
    const f = inflight as Flight | null;
    if (f?.tx) await markNightsBroadcast(db, f.batch, f.claimId, f.tx, f.nonce ?? null, f.sender ?? null, deps.now()).catch(() => undefined);
  } finally {
    for (const u of unsent) await releaseNightClaims(db, u.ids, u.claimId).catch(() => undefined);
  }

  let first = false;
  try {
    if (txs.length) await appendShiftTxs(db, shiftId, txs); // single statement: never loses a concurrent pass's txs
    const pending = await countUnattested(db, shiftId);
    first = await claimShiftFinalization(db, shiftId, deps.now());
    await updateShift(db, shiftId, {
      status: pending === 0 ? 'attested' : 'attest_pending',
      notes: pending === 0 ? null : note ?? shift.notes,
      finishedAt: deps.now(),
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
