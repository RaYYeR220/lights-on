import { ToolError } from '@/lib/mcp/errors';
import { clientIp, hashIp } from '@/lib/shift/limits';

/**
 * Process-level read cache for the open surfaces (REST, MCP, the tower). Neon HTTP bills transfer and compute per
 * query, and the MCP endpoint (POST) never reaches the CDN, so each instance answers a repeated read from memory for
 * TTL_MS. Keys are built from normalized arguments only. In-flight reads are shared; failures are never cached.
 */
export const API_CACHE_TTL_MS = 120_000;
const MAX_ENTRIES = 500;
const store = new Map<string, { exp: number; v: Promise<unknown> }>();

export function resetApiCache(): void {
  store.clear();
  misses.clear();
}

export function isCached(key: string, now = Date.now()): boolean {
  const hit = store.get(key);
  return !!hit && hit.exp > now;
}

/** The cached value of `key`, or `load()` (stored for `ttlMs`; a rejection is dropped so the next call retries). */
export function cached<T>(key: string, load: () => Promise<T>, ttlMs = API_CACHE_TTL_MS, now = Date.now()): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.exp > now) return hit.v as Promise<T>;
  const v = load();
  store.delete(key);
  store.set(key, { exp: now + ttlMs, v });
  v.catch(() => { if (store.get(key)?.v === v) store.delete(key); });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
  return v;
}

/**
 * Reads that miss the cache (the ones that reach the database), per requester: at most MISS_LIMIT per MISS_WINDOW_MS
 * per instance. Cached answers are never limited.
 */
export const MISS_LIMIT = 60;
export const MISS_WINDOW_MS = 10 * 60_000;
const misses = new Map<string, number[]>();

function missKey(h: Headers): string {
  return hashIp(clientIp(h), 'reads', process.env.INTERNAL_RUN_TOKEN || 'lights-on-reads');
}

/** Throws ToolError(rate_limited) when this requester has spent its database reads for the window. */
function chargeMiss(h: Headers, now: number): void {
  const key = missKey(h);
  const recent = (misses.get(key) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
  if (recent.length >= MISS_LIMIT) {
    misses.set(key, recent);
    throw new ToolError('rate_limited', 429, Math.max(1, Math.ceil((recent[0] + MISS_WINDOW_MS - now) / 1000)));
  }
  recent.push(now);
  misses.delete(key);
  misses.set(key, recent);
  while (misses.size > 5000) misses.delete(misses.keys().next().value as string);
}

/** `cached`, charging the requester's miss budget only when the database is actually read. */
export function cachedRead<T>(key: string, headers: Headers, load: () => Promise<T>, now = Date.now()): Promise<T> {
  if (!isCached(key, now)) {
    try {
      chargeMiss(headers, now);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return cached(key, load, API_CACHE_TTL_MS, now);
}
