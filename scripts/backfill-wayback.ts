import { loadEnv, arg, daysArg, sleep, writeSummary } from './_backfill';
import { safeFetch } from '@/lib/net/safeFetch';
import { extractFingerprint } from '@/lib/adapters/liveapp';
import {
  cdxUrl, parseCdx, sampleCaptures, captureUrl, deployNights, WAYBACK_UA, MAX_CAPTURES, type FingerprintedCapture,
} from '@/lib/adapters/wayback';
import { hashEvidence, RULES_VERSION } from '@/lib/shift/evidence';
import { decideStatus } from '@/lib/shift/rules';
import { nightDate, nightlyWindow, shiftStartFor, shiftStartOfNight } from '@/lib/shift/night';
import type { EvidenceBundle, LiveAppFacts } from '@/lib/types';

loadEnv();

const DAY = 86_400_000;
const GAP_MS = 1_500;
const headers = { 'user-agent': WAYBACK_UA };

/** Wayback resets connections when it is busy: retry with backoff, then give up on this request only. */
async function wbFetch(url: string, timeoutMs: number) {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await safeFetch(url, { headers, timeoutMs });
      if (res.status !== 429 && res.status < 500) return res;
      last = new Error(`http ${res.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(5_000 * (i + 1));
  }
  throw last;
}

async function main() {
  const days = daysArg();
  const only = arg('only');
  const shiftStart = shiftStartFor(new Date());
  const since = new Date(shiftStart.getTime() - days * DAY);

  const [{ getDb }, q] = await Promise.all([import('@/lib/db'), import('@/lib/db/queries')]);
  const db = await getDb();
  const projects = (await q.listProjects(db, { includeHidden: true })).filter((p) => p.liveUrl && (!only || p.slug === only));
  console.log(`backfill-wayback: ${projects.length} sites, from ${since.toISOString().slice(0, 10)}`);

  const summary: Record<string, unknown>[] = [];
  for (const p of projects) {
    const row: Record<string, unknown> = { project: p.slug, url: p.liveUrl };
    try {
      const cdx = await wbFetch(cdxUrl(p.liveUrl!, since), 40_000);
      if (cdx.status !== 200) throw new Error(`cdx http ${cdx.status}`);
      const all = parseCdx(cdx.body);
      const picked = sampleCaptures(all, MAX_CAPTURES);
      const fps: FingerprintedCapture[] = [];
      const bodies = new Map<string, { bytes: number; title: string | null; textHash: string | null; original: string }>();
      for (const c of picked) {
        await sleep(GAP_MS);
        try {
          const res = await wbFetch(captureUrl(c), 30_000);
          if (res.status !== 200) continue;
          const f = extractFingerprint(res.body, c.original);
          fps.push({ timestamp: c.timestamp, deployFingerprint: f.deployFingerprint });
          bodies.set(c.timestamp, { bytes: Buffer.byteLength(res.body), title: f.title, textHash: f.textHash, original: c.original });
        } catch { /* skip this capture */ }
      }

      const deploys = deployNights(fps).filter((d) => {
        const t = Date.parse(nightDate(d.night));
        return t + 5 * 3_600_000 <= shiftStart.getTime() && t + 5 * 3_600_000 > since.getTime();
      });
      const existing = await q.getNights(db, p.id, { from: since.toISOString().slice(0, 10) });
      let merged = 0;
      let created = 0;
      for (const d of deploys) {
        const date = nightDate(d.night);
        const cap = bodies.get(d.timestamp)!;
        const live: LiveAppFacts = {
          url: p.liveUrl!, finalUrl: cap.original, httpStatus: 200, up: true, latencyMs: null,
          deployFingerprint: d.fingerprint, textHash: cap.textHash, title: cap.title, bytes: cap.bytes, newDeploy: true, textDelta: null,
        };
        const prevRow = existing.find((n) => n.night === date && n.observed === false);
        const prevBundle = prevRow?.evidenceHash ? await q.getEvidence(db, prevRow.evidenceHash) : null;
        const bundle: EvidenceBundle = prevBundle ?? {
          v: 1, rulesVersion: RULES_VERSION, project: p.slug, night: d.night, kind: 'nightly',
          window: nightlyWindow(shiftStartOfNight(date)),
          sources: { repo: null, liveapp: null, chain: null, vibestarter: null },
        };
        bundle.sources.liveapp = { source: 'liveapp', tier: 'verified', ok: true, facts: live };
        const decision = decideStatus(bundle);
        const hash = hashEvidence(bundle);
        await q.saveEvidence(db, hash, p.id, date, bundle);
        await q.upsertReconstructedNight(db, {
          projectId: p.id, night: date, shiftId: null, status: decision.status, observed: false,
          signals: { reconstructed: true, source: prevBundle ? 'git+wayback' : 'wayback', reasons: decision.reasons, capture: d.timestamp },
          evidenceHash: hash, aiOk: false, summary: null,
        });
        if (prevRow) merged++;
        else created++;
      }
      Object.assign(row, { ok: true, cdxRows: all.length, capturesFetched: fps.length, deployNights: deploys.map((d) => d.night), merged, created });
      console.log(`${p.slug.padEnd(26)} cdx=${String(all.length).padStart(3)} fetched=${String(fps.length).padStart(2)} deploys=${deploys.length} merged=${merged} created=${created}`);
    } catch (e) {
      Object.assign(row, { ok: false, error: (e as Error).message });
      console.log(`${p.slug.padEnd(26)} FAILED ${(e as Error).message}`);
    }
    summary.push(row);
    await sleep(GAP_MS);
  }
  const file = writeSummary('wayback', { days, since: since.toISOString(), projects: summary });
  console.log(`summary -> ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
