import { loadEnv, arg, daysArg, sleep, writeSummary } from './_backfill';
import { safeFetch } from '@/lib/net/safeFetch';
import { extractFingerprint } from '@/lib/adapters/liveapp';
import {
  cdxUrl, parseCdx, sampleCaptures, captureUrl, coverage, WAYBACK_UA, MAX_CAPTURES, type CaptureEntry,
} from '@/lib/adapters/wayback';
import { writeReconstructed } from '@/lib/backfill/store';
import { nightNumber, shiftStartFor } from '@/lib/shift/night';
import type { LiveAppFacts } from '@/lib/types';

loadEnv();

const DAY = 86_400_000;
const GAP_MS = 1_500;
const headers = { 'user-agent': WAYBACK_UA };

/** Wayback resets connections when it is busy: retry with backoff, then give up on this request only. */
async function wbFetch(url: string, timeoutMs: number) {
  const tries = 4;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await safeFetch(url, { headers, timeoutMs });
      if (res.status !== 429 && res.status < 500) return res;
      last = new Error(`http ${res.status}`);
    } catch (e) {
      last = e;
    }
    if (i < tries - 1) await sleep(5_000 * (i + 1));
  }
  throw last;
}

interface Detail { bytes: number; title: string | null; textHash: string | null; original: string }

async function main() {
  const days = daysArg();
  const only = arg('only');
  const shiftStart = shiftStartFor(new Date());
  const since = new Date(shiftStart.getTime() - days * DAY);
  const windowNights = new Set<number>();
  for (let k = 1; k <= days; k++) windowNights.add(nightNumber(new Date(shiftStart.getTime() - (k - 1) * DAY)));

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
      const all = parseCdx(cdx.body).map((c, idx) => ({ ...c, idx }));
      const picked = sampleCaptures(all, MAX_CAPTURES);
      const entries: CaptureEntry[] = [];
      const details = new Map<string, Detail>();
      for (const c of picked) {
        await sleep(GAP_MS);
        try {
          const res = await wbFetch(captureUrl(c), 30_000);
          if (res.status !== 200) throw new Error(`http ${res.status}`);
          const f = extractFingerprint(res.body, c.original);
          entries.push({ timestamp: c.timestamp, idx: c.idx, fingerprint: f.deployFingerprint });
          details.set(c.timestamp, { bytes: Buffer.byteLength(res.body), title: f.title, textHash: f.textHash, original: c.original });
        } catch {
          entries.push({ timestamp: c.timestamp, idx: c.idx, fingerprint: null, failed: true });
        }
      }
      const capturesFailed = entries.filter((e) => e.failed).length;
      const capturesFetched = entries.length - capturesFailed;
      Object.assign(row, { cdxRows: all.length, capturesFetched, capturesFailed });
      if (entries.length > 0 && capturesFetched === 0) {
        Object.assign(row, { ok: false, status: 'failed', error: 'all captures failed; nothing written' });
        console.log(`${p.slug.padEnd(26)} FAILED all ${capturesFailed} captures failed`);
        summary.push(row);
        await sleep(GAP_MS);
        continue;
      }

      const claims = coverage(entries, windowNights);
      const prevRows = await q.getNights(db, p.id, { from: since.toISOString().slice(0, 10) });
      const prevByDate = new Map(prevRows.filter((n) => !n.observed).map((n) => [n.night, n]));
      const written = { inserted: 0, updated: 0, unchanged: 0 };
      for (const c of claims) {
        const d = details.get(c.timestamp)!;
        const live: LiveAppFacts = {
          url: p.liveUrl!, finalUrl: d.original, httpStatus: 200, up: true, latencyMs: null,
          deployFingerprint: c.fingerprint, textHash: d.textHash, title: d.title, bytes: d.bytes, newDeploy: c.kind === 'deploy', textDelta: null,
        };
        const date = `${String(c.night).slice(0, 4)}-${String(c.night).slice(4, 6)}-${String(c.night).slice(6, 8)}`;
        const r = await writeReconstructed(db, p, c.night, (b) => {
          b.sources.liveapp = { source: 'liveapp', tier: 'verified', ok: true, facts: live };
        }, { replaces: 'liveapp', prevRow: prevByDate.get(date) ?? null, extraSignals: { note: c.note, capture: c.timestamp } });
        written[r.outcome]++;
      }
      const deploys = claims.filter((c) => c.kind === 'deploy').map((c) => c.night);
      const quiet = claims.length - deploys.length;
      Object.assign(row, { ok: true, status: capturesFailed > 0 ? 'partial' : 'ok', deployNights: deploys, quietNights: quiet, ...written });
      console.log(`${p.slug.padEnd(26)} cdx=${String(all.length).padStart(3)} fetched=${String(capturesFetched).padStart(2)} failed=${capturesFailed} deploys=${deploys.length} quiet=${quiet} new=${written.inserted} upd=${written.updated} same=${written.unchanged}${capturesFailed > 0 ? ' PARTIAL' : ''}`);
    } catch (e) {
      Object.assign(row, { ok: false, status: 'failed', error: (e as Error).message });
      console.log(`${p.slug.padEnd(26)} FAILED ${(e as Error).message}`);
    }
    summary.push(row);
    await sleep(GAP_MS);
  }
  const file = writeSummary('wayback', { days, since: since.toISOString(), projects: summary });
  console.log(`summary -> ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
