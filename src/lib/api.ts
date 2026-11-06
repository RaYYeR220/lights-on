import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { ToolError } from '@/lib/mcp/tools';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
export const CACHE_5MIN = 'public, s-maxage=300';

/** 200 JSON, edge-cacheable for 5 minutes, open CORS. */
export const ok = (body: unknown): Response => json(body, 200, { ...CORS, 'cache-control': CACHE_5MIN });

/** Fixed error codes only; never the exception text. Errors are not cached. */
export function fail(e: unknown): Response {
  if (e instanceof ToolError) {
    return json({ error: e.code }, e.status, { ...CORS, ...(e.retryAfterSec ? { 'retry-after': String(e.retryAfterSec) } : {}) });
  }
  console.error('api failed:', safeErrorCode(e));
  return json({ error: 'internal' }, 500, CORS);
}

/** Decoded `k=v` pairs, sorted: the same set however it is encoded or ordered. */
const pairKey = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${v}`).sort().join('&');

/**
 * The CDN caches by full URL, so `?x=<random>` would reach the function (and the database) every time. A request whose
 * DECODED query differs from the canonical one (unknown params, other values) gets a 307 to it; the redirect itself
 * costs no database read. The compare is on decoded, sorted pairs because Next re-encodes the URL before the handler
 * runs (`,` arrives as `%2C`): comparing raw strings looped forever. The redirect is never cached, so a wrong one can
 * never stay pinned at the CDN.
 */
export function canonicalRedirect(req: Request, query: [string, string][]): Response | null {
  const u = new URL(req.url);
  if (pairKey([...u.searchParams]) === pairKey(query)) return null;
  const canon = query.length ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return new Response(null, {
    status: 307,
    headers: { ...CORS, location: `${u.pathname}${canon}`, 'cache-control': 'no-store' },
  });
}

export const preflight = (): Response => new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });

/** yyyymmdd query param -> number; undefined when absent; ToolError(bad_request) when malformed. */
export function nightParam(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  if (!/^\d{8}$/.test(v)) throw new ToolError('bad_request', 400);
  return Number(v);
}
