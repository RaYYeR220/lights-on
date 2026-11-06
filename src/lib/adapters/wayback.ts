import { nightContaining } from '@/lib/shift/night';

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

/** Nights in which the deploy fingerprint differs from the previous hashed capture (captures sorted by time). */
export function deployNights(caps: FingerprintedCapture[]): { night: number; timestamp: string; fingerprint: string }[] {
  const out: { night: number; timestamp: string; fingerprint: string }[] = [];
  let prev: string | null = null;
  for (const c of caps) {
    if (!c.deployFingerprint) continue;
    if (prev !== null && c.deployFingerprint !== prev) {
      out.push({ night: nightContaining(parseWaybackTimestamp(c.timestamp)), timestamp: c.timestamp, fingerprint: c.deployFingerprint });
    }
    prev = c.deployFingerprint;
  }
  return out;
}
