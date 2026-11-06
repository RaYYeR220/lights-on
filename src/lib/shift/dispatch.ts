import { createNightlyShift, listProjects, markShiftRunDone } from '@/lib/db/queries';
import type { ShiftDeps } from './deps';
import { finalizeShift } from './finalize';
import { nightDate, nightNumber, shiftStartFor } from './night';

/** accepted = 202 from /api/shift/run; refused = it definitely did not start; unknown = timeout / gateway error. */
export type TriggerResult = 'accepted' | 'refused' | 'unknown';
export interface DispatchDeps extends ShiftDeps {
  trigger: (projectId: number, shiftId: number) => Promise<TriggerResult>;
}

export const DISPATCH_CONCURRENCY = 6;
const TRIGGER_TIMEOUT_MS = 10_000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Create tonight's nightly shift (idempotent on the night: a cron retry gets created=false and fires nothing) and fire
 * one run per watched project, at most 6 in flight. Each run reports back by incrementing `shifts.done`.
 * Tonight comes first: the stale pass for older shifts is the caller's job, afterwards (the route runs it in after()).
 */
export async function dispatchShift(now: Date, deps: DispatchDeps): Promise<{ shiftId: number; planned: number; created: boolean }> {
  const night = nightDate(nightNumber(shiftStartFor(now)));
  const projects = await listProjects(deps.db);
  const { shift, created } = await createNightlyShift(deps.db, { night, startedAt: now, planned: projects.length });
  if (!created) return { shiftId: shift.id, planned: shift.planned, created: false };
  if (projects.length === 0) {
    await finalizeShift(shift.id, deps);
    return { shiftId: shift.id, planned: 0, created: true };
  }

  const results = await mapLimit(projects, DISPATCH_CONCURRENCY, async (p): Promise<TriggerResult> => {
    try {
      return await deps.trigger(p.id, shift.id);
    } catch {
      return 'unknown';
    }
  });
  // A refused run will never report back: count it here so the shift can close (finalize fills it as unavailable).
  for (const r of results) {
    if (r !== 'refused') continue;
    const c = await markShiftRunDone(deps.db, shift.id);
    if (c && c.done === c.planned) await finalizeShift(shift.id, deps);
  }
  return { shiftId: shift.id, planned: projects.length, created: true };
}

/**
 * Fire-and-forget POST to our own /api/shift/run (fixed, operator-configured base URL, not user input; so plain
 * fetch, not safeFetch). Waits only for the 202 headers; the run works in `after()`.
 */
export function httpTrigger(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): DispatchDeps['trigger'] {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/shift/run`;
  return async (projectId, shiftId) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({ projectId, shiftId }),
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
        cache: 'no-store',
      });
      res.body?.cancel().catch(() => undefined);
      if (res.status === 202) return 'accepted';
      return (res.status >= 400 && res.status < 500) || res.status === 500 ? 'refused' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
