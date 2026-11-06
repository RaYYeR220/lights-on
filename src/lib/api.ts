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

export const preflight = (): Response => new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });

/** yyyymmdd query param -> number; undefined when absent; ToolError(bad_request) when malformed. */
export function nightParam(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  if (!/^\d{8}$/.test(v)) throw new ToolError('bad_request', 400);
  return Number(v);
}
