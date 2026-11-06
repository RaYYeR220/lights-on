import type { TimeWindow } from '@/lib/types';

/** Scheduled shift time (cron `0 5 * * *`). Hobby crons fire anywhere inside the hour, so the start is normalised. */
export const SHIFT_HOUR_UTC = 5;
const DAY_MS = 86_400_000;

/** Latest scheduled shift start (05:00 UTC) at or before `now`. Contiguous, jitter-proof nightly windows. */
export function shiftStartFor(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SHIFT_HOUR_UTC));
  return d.getTime() > now.getTime() ? new Date(d.getTime() - DAY_MS) : d;
}

/** UTC calendar date of `d` as yyyymmdd. */
export function nightNumber(d: Date): number {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** yyyymmdd -> 'yyyy-mm-dd' (the `date` columns). */
export function nightDate(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 'yyyy-mm-dd' -> yyyymmdd. */
export function nightOf(date: string): number {
  return Number(date.slice(0, 10).replace(/-/g, ''));
}

/** UTC day key 'yyyy-mm-dd' for the per-day budget. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Nightly window = [shiftStart - 24 h, shiftStart). */
export function nightlyWindow(shiftStart: Date): TimeWindow {
  return { start: new Date(shiftStart.getTime() - DAY_MS).toISOString(), end: shiftStart.toISOString() };
}

/** The scheduled start of the nightly shift for a night date ('yyyy-mm-dd'). */
export function shiftStartOfNight(date: string): Date {
  return new Date(`${date.slice(0, 10)}T${String(SHIFT_HOUR_UTC).padStart(2, '0')}:00:00.000Z`);
}
