import { createHash, createHmac } from 'node:crypto';
import { deleteLiveRun, insertLiveRun, recentLiveRuns } from '@/lib/db/queries';
import type { Db } from '@/lib/db';
import type { ShiftDeps } from './deps';

/** Fail-closed caps. Per-day counters live in `budget`, per-shift counters on the `shifts` row. */
export const CAPS = {
  llmTokensPerShift: 400_000,
  llmTokensPerDay: 1_500_000,
  gasWeiPerDay: 1_000_000_000_000_000n, // 0.001 ETH
  liveRunsPerDay: 60,
  githubCallsPerNight: 400,
  /** Live runs: hard per-run cap, plus the daily `github_calls` counter (live calls only) at 30/hour x 24. */
  githubCallsPerLiveRun: 3,
  githubLiveCallsPerDay: 720,
} as const;

export const LIVE_LIMITS = {
  perIp: 3,
  perIpWindowMs: 10 * 60_000,
  perProject: 1,
  perProjectWindowMs: 5 * 60_000,
  perDay: CAPS.liveRunsPerDay,
} as const;

export type LiveLimitReason = 'project_cooldown' | 'ip_limit' | 'daily_cap';
export type LiveLimit =
  | { ok: true; liveRunId: number }
  | { ok: false; retryAfterSec: number; reason: LiveLimitReason };
export type LimitDeps = Pick<ShiftDeps, 'db' | 'now' | 'budget' | 'release'>;

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

async function windowCheck(
  db: Db, ipHash: string, projectId: number, now: Date, beforeId?: number,
): Promise<Extract<LiveLimit, { ok: false }> | null> {
  const t = now.getTime();
  const proj = await recentLiveRuns(db, { projectId }, new Date(t - LIVE_LIMITS.perProjectWindowMs), beforeId);
  if (proj.length >= LIVE_LIMITS.perProject) {
    const newest = proj[0].startedAt.getTime();
    return { ok: false, reason: 'project_cooldown', retryAfterSec: secs(newest + LIVE_LIMITS.perProjectWindowMs - t) };
  }
  const ip = await recentLiveRuns(db, { ipHash }, new Date(t - LIVE_LIMITS.perIpWindowMs), beforeId);
  if (ip.length >= LIVE_LIMITS.perIp) {
    const freesUp = ip[LIVE_LIMITS.perIp - 1].startedAt.getTime(); // the oldest of the last `perIp` runs
    return { ok: false, reason: 'ip_limit', retryAfterSec: secs(freesUp + LIVE_LIMITS.perIpWindowMs - t) };
  }
  return null;
}

function untilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return secs(next - now.getTime());
}

/**
 * Live-run admission: 1 per project per 5 min, 3 per requester per 10 min, 60 per UTC day.
 * Reserve-then-verify so concurrent requests cannot both slip through: cheap pre-check (no writes), atomic daily
 * counter, insert the `live_runs` row, then re-check counting only earlier rows. A loser deletes its row and refunds
 * the daily count. On success the reserved row id is returned; the run must reuse it.
 */
export async function checkLiveLimit(ipHash: string, projectId: number, deps: LimitDeps): Promise<LiveLimit> {
  const now = deps.now();
  const pre = await windowCheck(deps.db, ipHash, projectId, now);
  if (pre) return pre;
  if (!(await deps.budget('live_runs', 1))) return { ok: false, reason: 'daily_cap', retryAfterSec: untilUtcMidnight(now) };
  const row = await insertLiveRun(deps.db, { projectId, requesterIpHash: ipHash, startedAt: now, status: 'running' });
  const post = await windowCheck(deps.db, ipHash, projectId, now, row.id);
  if (post) {
    await deleteLiveRun(deps.db, row.id);
    await deps.release?.('live_runs', 1);
    return post;
  }
  return { ok: true, liveRunId: row.id };
}

/** Requester key: sha256(daily salt + ip), salt = HMAC(INTERNAL_RUN_TOKEN, day). Raw IPs are never stored. */
export function hashIp(ip: string, day: string, secret: string): string {
  const salt = createHmac('sha256', secret || 'lights-on').update(day).digest('hex');
  return createHash('sha256').update(salt + ip).digest('hex');
}

/** Client address as set by the platform (Vercel overwrites both headers). */
export function clientIp(h: Headers): string {
  const real = h.get('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd ? fwd.slice(0, 64) : 'unknown';
}
