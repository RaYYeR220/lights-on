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

/** `Authorization: Bearer <secret>` check. */
export function bearerEquals(header: string | null, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return !!m && secretEquals(m[1], expected);
}
