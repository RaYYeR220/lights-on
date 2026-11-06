import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { bearerEquals, json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { makeShiftDeps } from '@/lib/shift/deps';
import { withNotify } from '@/lib/notify/send';
import { dispatchShift, httpTrigger } from '@/lib/shift/dispatch';
import { maybeFinalizeStale } from '@/lib/shift/finalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Vercel Cron (05:00 UTC): `Authorization: Bearer ${CRON_SECRET}`. */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const token = process.env.INTERNAL_RUN_TOKEN;
  if (!secret) return json({ error: 'not_configured' }, 503);
  if (!bearerEquals(req.headers.get('authorization'), secret)) return json({ error: 'unauthorized' }, 401);
  if (!token) return json({ error: 'not_configured' }, 503);
  try {
    const db = await getDb();
    // Our own deployment: the host Vercel routed this request to (or an explicit override).
    const base = process.env.INTERNAL_BASE_URL || new URL(req.url).origin;
    const deps = { ...withNotify(makeShiftDeps(db, { kind: 'nightly' })), trigger: httpTrigger(base, token) };
    const r = await dispatchShift(new Date(), deps);
    // Tonight's shift is created and its runs are fired; only now settle older shifts (bounded to 60 s).
    after(() => maybeFinalizeStale(deps).catch((e) => { console.error('shift.stale failed:', safeErrorCode(e)); }));
    return json(r, 200);
  } catch (e) {
    console.error('shift.dispatch failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
