import { getDb } from '@/lib/db';
import { bearerEquals, json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { makeShiftDeps } from '@/lib/shift/deps';
import { maybeFinalizeStale } from '@/lib/shift/finalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron (06:00 UTC), `Authorization: Bearer ${CRON_SECRET}`: one bounded (60 s) stale-shift pass, an hour after
 * dispatch, so a stuck shift does not have to wait for the next night.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: 'not_configured' }, 503);
  if (!bearerEquals(req.headers.get('authorization'), secret)) return json({ error: 'unauthorized' }, 401);
  try {
    const db = await getDb();
    const finalized = await maybeFinalizeStale(makeShiftDeps(db, { kind: 'nightly' }));
    return json({ finalized }, 200);
  } catch (e) {
    console.error('shift.finalize-stale failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
