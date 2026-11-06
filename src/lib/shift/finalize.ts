import { keccak256, toBytes, type Hex } from 'viem';
import {
  DuplicateNight, claimShiftFinalization, claimShiftNights, countUnattested, getNightsForProjects, getProjectsByIds,
  getShift, insertNight, listProjects, listStaleShifts, releaseNightClaims, saveEvidence, setNightAttestations, updateShift,
} from '@/lib/db/queries';
import type { NightRow, ShiftRow } from '@/lib/db/schema';
import type { NightAttestation } from '@/lib/attest/eas';
import { safeErrorCode } from '@/lib/net/redact';
import { STATUS_CODE, type EvidenceBundle, type Kind, type Status } from '@/lib/types';
import { computeRecord, decideStatus } from './rules';
import { hashEvidence, RULES_VERSION } from './evidence';
import { attestDepsFor, siteUrlOf, type ShiftDeps } from './deps';
import { nightDate, nightNumber, nightOf, nightlyWindow, shiftStartOfNight } from './night';

export const ATTEST_BATCH = 20;
export const STALE_AFTER_MS = 45 * 60_000;
const MISSING_SUMMARY = 'The check for this project did not complete in this shift, so no claim is made either way.';

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
 * Close a nightly shift: fill missing nights, claim unattested rows atomically (each row reaches exactly one caller),
 * attest them with multiAttest in batches of 20, write UIDs + tx back. A skipped batch releases its claims (and
 * those of later batches) so a later pass can retry; the shift is then `attest_pending`. Safe to call repeatedly
 * and concurrently. onFinalized fires once, from the call that first closed the shift.
 */
export async function finalizeShift(shiftId: number, deps: ShiftDeps): Promise<{ attested: number; txHash?: Hex; skipped?: string }> {
  const { db } = deps;
  const shift = await getShift(db, shiftId);
  if (!shift || shift.kind !== 'nightly') return { attested: 0, skipped: 'not_found' };
  const first = await claimShiftFinalization(db, shiftId, deps.now());
  await fillMissingNights(shift, deps);

  const claimed = (await claimShiftNights(db, shiftId)).sort((a, b) => a.id - b.id);
  let attested = 0;
  let txHash: Hex | undefined;
  let skipped: string | undefined;

  if (claimed.length > 0) {
    let note: string | null = null;
    const txs: string[] = [];
    try {
      const ids = [...new Set(claimed.map((r) => r.projectId))];
      const slugs = new Map((await getProjectsByIds(db, ids)).map((p) => [p.id, p.slug]));
      const night = nightOf(shift.night);
      const history = await getNightsForProjects(db, ids, lit30From(night));
      const atts = claimed.map((row) => toAttestation({
        slug: slugs.get(row.projectId) ?? String(row.projectId),
        night: nightOf(row.night),
        kind: 'nightly',
        status: row.status,
        lit30: lit30Of(history.filter((h) => h.projectId === row.projectId), nightOf(row.night)),
        evidenceHash: row.evidenceHash as Hex,
      }, deps));

      for (let i = 0; i < claimed.length; i += ATTEST_BATCH) {
        const rows = claimed.slice(i, i + ATTEST_BATCH);
        let r: Awaited<ReturnType<ShiftDeps['attestMany']>>;
        try {
          r = await deps.attestMany(atts.slice(i, i + ATTEST_BATCH), attestDepsFor(deps));
        } catch (e) {
          r = { skipped: 'error', error: safeErrorCode(e) };
        }
        if ('skipped' in r) {
          skipped = r.skipped;
          note = `skipped:${r.skipped}${r.error ? `:${r.error}` : ''}`;
          await releaseNightClaims(db, claimed.slice(i).map((x) => x.id));
          break;
        }
        const res = r;
        await setNightAttestations(db, rows.map((row, k) => ({ id: row.id, uid: res.uids[k] })), res.txHash);
        attested += rows.length;
        txHash = res.txHash;
        txs.push(res.txHash);
      }
    } catch (e) {
      // DB/encoding failure mid-way: hand back whatever is still unattested
      skipped ??= 'error';
      note ??= `skipped:error:${safeErrorCode(e)}`;
      await releaseNightClaims(db, claimed.map((x) => x.id)).catch(() => undefined);
    }
    const pending = await countUnattested(db, shiftId);
    await updateShift(db, shiftId, {
      status: pending === 0 ? 'attested' : 'attest_pending',
      notes: pending === 0 ? null : note,
      finishedAt: deps.now(),
      ...(txs.length ? { attestTx: [shift.attestTx, ...txs].filter(Boolean).join(',') } : {}),
    });
  } else {
    // Nothing claimable: either all attested, or another finalize holds the rows right now.
    const pending = await countUnattested(db, shiftId);
    if (pending === 0 && shift.status !== 'attested') await updateShift(db, shiftId, { status: 'attested', notes: null });
    else if (pending > 0 && shift.status === 'attest_pending') await updateShift(db, shiftId, { finishedAt: deps.now() });
  }

  if (first && deps.onFinalized) {
    try { await deps.onFinalized(shiftId); } catch (e) { console.error('shift.onFinalized failed:', safeErrorCode(e)); }
  }
  return { attested, ...(txHash ? { txHash } : {}), ...(skipped ? { skipped } : {}) };
}

/** Finalize nightly shifts stuck > 45 min (or with attestations pending, retried every 45 min, for 48 h). */
export async function maybeFinalizeStale(deps: ShiftDeps): Promise<number> {
  const stale = await listStaleShifts(deps.db, deps.now(), STALE_AFTER_MS);
  let n = 0;
  for (const s of stale) {
    try {
      await finalizeShift(s.id, deps);
      n++;
    } catch (e) {
      console.error('shift.finalize failed:', safeErrorCode(e));
    }
  }
  return n;
}
