import type { Db } from '@/lib/db';
import { getEvidence, getNights, saveEvidence, upsertReconstructedNight } from '@/lib/db/queries';
import type { NightRow } from '@/lib/db/schema';
import { hashEvidence, RULES_VERSION } from '@/lib/shift/evidence';
import { decideStatus } from '@/lib/shift/rules';
import { nightDate, nightlyWindow, shiftStartOfNight } from '@/lib/shift/night';
import type { EvidenceBundle, Status } from '@/lib/types';

export function emptyBundle(slug: string, night: number): EvidenceBundle {
  return {
    v: 1, rulesVersion: RULES_VERSION, project: slug, night, kind: 'nightly',
    window: nightlyWindow(shiftStartOfNight(nightDate(night))),
    sources: { repo: null, liveapp: null, chain: null, vibestarter: null },
  };
}

/** 'git', 'wayback' or 'git+wayback': which backfills contributed evidence to this reconstructed night. */
export function sourcesOf(b: EvidenceBundle): string {
  return [b.sources.repo ? 'git' : null, b.sources.liveapp ? 'wayback' : null].filter(Boolean).join('+');
}

export interface WriteResult { outcome: 'inserted' | 'updated' | 'unchanged'; status: Status }

/**
 * Order-independent write of one reconstructed (observed=false) night: load the existing reconstructed bundle,
 * apply `patch` (which replaces exactly one source), re-decide, re-hash, save evidence, upsert the row.
 * `prevRow`: the existing reconstructed row if the caller already loaded it (null = none; undefined = load here).
 * `replaces`: the source the patch overwrites; when the stored row only holds that source the old bundle is not loaded.
 */
export async function writeReconstructed(
  db: Db,
  p: { id: number; slug: string },
  night: number,
  patch: (b: EvidenceBundle) => void,
  opts: { replaces: 'repo' | 'liveapp'; prevRow?: NightRow | null; extraSignals?: Record<string, unknown> },
): Promise<WriteResult> {
  const date = nightDate(night);
  let prevRow = opts.prevRow;
  if (prevRow === undefined) {
    prevRow = (await getNights(db, p.id, { from: date, to: date })).find((n) => !n.observed) ?? null;
  }
  const ownSource = opts.replaces === 'repo' ? 'git' : 'wayback';
  const onlyOwn = (prevRow?.signals as { source?: string } | null)?.source === ownSource;
  const prev = prevRow?.evidenceHash && !onlyOwn ? await getEvidence(db, prevRow.evidenceHash) : null;
  const bundle = prev ?? emptyBundle(p.slug, night);
  patch(bundle);
  const decision = decideStatus(bundle);
  const hash = hashEvidence(bundle);
  if (prevRow && prevRow.evidenceHash === hash) return { outcome: 'unchanged', status: decision.status };
  await saveEvidence(db, hash, p.id, date, bundle);
  await upsertReconstructedNight(db, {
    projectId: p.id, night: date, shiftId: null, status: decision.status, observed: false,
    signals: { reconstructed: true, source: sourcesOf(bundle), reasons: decision.reasons, ...opts.extraSignals },
    evidenceHash: hash, aiOk: false, summary: null,
  });
  return { outcome: prevRow ? 'updated' : 'inserted', status: decision.status };
}
