import { nightContaining, nightNumber } from '@/lib/shift/night';

export interface Capture { timestamp: string; original: string; digest: string }
export interface FingerprintedCapture { timestamp: string; deployFingerprint: string | null }

export const WAYBACK_UA = 'LightsOnWatcher/1.0 (+https://github.com/RaYYeR220/lights-on)';
export const MAX_CAPTURES = 15;

const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** CDX query for one live URL: host+path, 200s only, one row per distinct content digest. */
export function cdxUrl(liveUrl: string, from: Date): string {
  const u = new URL(liveUrl);
  const target = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  const q = new URLSearchParams({
    url: target, output: 'json', from: yyyymmdd(from), collapse: 'digest', filter: 'statuscode:200', fl: 'timestamp,original,digest',
  });
  return `https://web.archive.org/cdx/search/cdx?${q.toString()}`;
}

/** CDX json: header row then [timestamp, original, digest] rows. Anything else -> []. */
export function parseCdx(body: string): Capture[] {
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const out: Capture[] = [];
  for (const r of rows.slice(1)) {
    if (Array.isArray(r) && /^\d{14}$/.test(String(r[0])) && typeof r[1] === 'string') {
      out.push({ timestamp: String(r[0]), original: r[1], digest: String(r[2] ?? '') });
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** At most `max` captures, spread evenly, always keeping the first and the last. */
export function sampleCaptures<T>(xs: T[], max = MAX_CAPTURES): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))]);
  return out;
}

/** Raw (un-rewritten) capture body. */
export const captureUrl = (c: Capture) => `https://web.archive.org/web/${c.timestamp}id_/${c.original}`;

export function parseWaybackTimestamp(ts: string): Date {
  return new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`);
}

/** yyyymmdd + k calendar days. */
export function nightPlus(n: number, k: number): number {
  const y = Math.floor(n / 10000), m = Math.floor((n % 10000) / 100), d = n % 100;
  return nightNumber(new Date(Date.UTC(y, m - 1, d + k)));
}

/** One fetched (or failed) capture; `idx` is its position in the full CDX list (sampling can skip captures in between). */
export interface CaptureEntry { timestamp: string; idx: number; fingerprint: string | null; failed?: boolean }
export interface NightClaim { night: number; kind: 'deploy' | 'quiet'; note: string; fingerprint: string; timestamp: string }

/**
 * Honest per-night claims from consecutive successful captures A < C (entries sorted by time):
 *  - differing fingerprints -> `deploy` on night(C); nights strictly between are unknown (no claim);
 *  - equal fingerprints AND no unfetched capture between them (idx adjacent) -> `quiet` on (night(A), night(C)];
 *  - a failed or hashless capture breaks the pair; nothing before the first / after the last capture.
 * Only nights in `window` are returned; a deploy claim beats a quiet claim for the same night.
 */
export function coverage(entries: CaptureEntry[], window: Set<number>): NightClaim[] {
  const out = new Map<number, NightClaim>();
  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i], c = entries[i + 1];
    if (a.failed || c.failed || !a.fingerprint || !c.fingerprint) continue;
    const nA = nightContaining(parseWaybackTimestamp(a.timestamp));
    const nC = nightContaining(parseWaybackTimestamp(c.timestamp));
    if (a.fingerprint !== c.fingerprint) {
      if (window.has(nC)) {
        out.set(nC, { night: nC, kind: 'deploy', note: `deploy between ${a.timestamp} and ${c.timestamp}`, fingerprint: c.fingerprint, timestamp: c.timestamp });
      }
    } else if (c.idx === a.idx + 1) {
      for (let n = nightPlus(nA, 1); n <= nC; n = nightPlus(n, 1)) {
        if (!window.has(n) || out.get(n)?.kind === 'deploy') continue;
        out.set(n, { night: n, kind: 'quiet', note: `inferred: same deploy fingerprint at ${a.timestamp} and ${c.timestamp}`, fingerprint: c.fingerprint, timestamp: c.timestamp });
      }
    }
  }
  return [...out.values()].sort((x, y) => x.night - y.night);
}
