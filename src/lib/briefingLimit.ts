import { clientIp, hashIp } from '@/lib/shift/limits';

export const BRIEFING_LIMIT = 30;
export const BRIEFING_WINDOW_MS = 10 * 60_000;
const MAX_KEYS = 5000;
// Per-instance (instances are ephemeral): a cheap guard against one client fanning out RPC / REST reads.
const hits = new Map<string, number[]>();

export function resetBriefingLimit(): void { hits.clear(); }

/** Fixed (non-daily) salt label so the hash is stable across the whole window. */
export function briefingKey(h: Headers): string {
  return hashIp(clientIp(h), 'briefing', process.env.INTERNAL_RUN_TOKEN || 'lights-on-briefing');
}

/** null = allowed; otherwise seconds until the oldest hit leaves the window. */
export function checkBriefingLimit(h: Headers, now = Date.now()): number | null {
  const key = briefingKey(h);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < BRIEFING_WINDOW_MS);
  if (recent.length >= BRIEFING_LIMIT) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((recent[0] + BRIEFING_WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  hits.delete(key);
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= BRIEFING_WINDOW_MS) || hits.size > MAX_KEYS) hits.delete(k);
      if (hits.size <= MAX_KEYS) break;
    }
  }
  return null;
}
