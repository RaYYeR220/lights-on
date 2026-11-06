import { after } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { json, secretEquals } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { makeShiftDeps } from '@/lib/shift/deps';
import { runShiftProject } from '@/lib/shift/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({ projectId: z.number().int().positive(), shiftId: z.number().int().positive() });

/** One project of a nightly shift. Internal only (`x-internal-token`); answers 202 at once, works in after(). */
export async function POST(req: Request): Promise<Response> {
  const token = process.env.INTERNAL_RUN_TOKEN;
  if (!token) return json({ error: 'not_configured' }, 503);
  if (!secretEquals(req.headers.get('x-internal-token'), token)) return json({ error: 'unauthorized' }, 401);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  after(async () => {
    try {
      const db = await getDb();
      const r = await runShiftProject(body.shiftId, body.projectId, makeShiftDeps(db, { kind: 'nightly', shiftId: body.shiftId }));
      if (!r.ok) console.warn('shift.run:', r.code);
    } catch (e) {
      console.error('shift.run failed:', safeErrorCode(e));
    }
  });
  return json({ accepted: true }, 202);
}
