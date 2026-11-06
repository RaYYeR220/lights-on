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

/**
 * The CDN caches by full URL, so `?x=<random>` would reach the function (and the database) every time. A request whose
 * query is not exactly the canonical one (known params only, fixed order and form) gets a cacheable 308 to it instead;
 * the redirect itself costs no database read.
 */
export function canonicalRedirect(req: Request, query: [string, string][]): Response | null {
  const u = new URL(req.url);
  const canon = query.length ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  if (u.search === canon) return null;
  return new Response(null, {
    status: 308,
    headers: { ...CORS, location: `${u.pathname}${canon}`, 'cache-control': 'public, s-maxage=86400' },
  });
}

export const preflight = (): Response => new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });

/** yyyymmdd query param -> number; undefined when absent; ToolError(bad_request) when malformed. */
export function nightParam(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  if (!/^\d{8}$/.test(v)) throw new ToolError('bad_request', 400);
  return Number(v);
}
