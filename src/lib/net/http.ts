import { createHash, timingSafeEqual } from 'node:crypto';

/** JSON response; bodies only ever carry fixed codes or our own data. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Constant-time secret comparison (hashing first equalises lengths). */
export function secretEquals(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Same-origin guard for side-effecting GETs started from our own pages. A request with an `Origin` header must come
 * from `site`'s origin; without one, a browser's `Sec-Fetch-Site` must say same-origin (or `none`: typed into the
 * address bar), which also stops no-cors embeds (<img>, <script>) that carry no Origin. Requests with neither header
 * (curl, server to server) pass: they are limited per IP like everyone else.
 */
export function sameOrigin(h: Headers, site: string): boolean {
  const origin = h.get('origin');
  if (origin !== null) {
    try {
      return new URL(origin).origin === new URL(site).origin;
    } catch {
      return false; // "null" (sandboxed frames, file://) or garbage
    }
  }
  const sfs = h.get('sec-fetch-site');
  if (sfs !== null) return sfs === 'same-origin' || sfs === 'none';
  return true;
}

/** `Authorization: Bearer <secret>` check. */
export function bearerEquals(header: string | null, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return !!m && secretEquals(m[1], expected);
}
