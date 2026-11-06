import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { getProjectBySlug, updateLiveRun } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { makeShiftDeps } from '@/lib/shift/deps';
import { withNotify } from '@/lib/notify/send';
import { checkLiveLimit, clientIp, hashIp } from '@/lib/shift/limits';
import { utcDay } from '@/lib/shift/night';
import { liveWindow, runProject, type RunResult } from '@/lib/shift/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PING_MS = 15_000;
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function donePayload(r: RunResult | null) {
  const a = r?.attestation;
  return {
    status: r?.status ?? null,
    evidenceHash: r?.evidenceHash ?? null,
    attestationUid: a && 'uid' in a ? a.uid : null,
    txHash: a ? (a.txHash ?? null) : null,
    attestSkipped: a && 'skipped' in a ? a.skipped : null,
    ...(r ? {} : { error: 'run_failed' }),
  };
}

/**
 * Live shift for one public project, streamed as SSE: `event: step` (Step JSON) ... then one `event: done`.
 * Never writes nights or snapshots, never runs the stale-shift pass (that lives on the internal routes).
 */
export async function GET(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get('project') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'bad_project' }, 400);
  const secret = process.env.INTERNAL_RUN_TOKEN;
  if (!secret) return json({ error: 'misconfigured' }, 503); // the requester-hash salt; never fall back to a constant

  let prepared;
  try {
    const db = await getDb();
    const project = await getProjectBySlug(db, slug);
    if (!project || project.hidden) return json({ error: 'not_found' }, 404);
    const deps = withNotify(makeShiftDeps(db, { kind: 'live' }));
    const now = deps.now();
    const window = await liveWindow(db, project.id, now); // before the reservation: nothing below can strand it
    const ipHash = hashIp(clientIp(req.headers), utcDay(now), secret);
    const limit = await checkLiveLimit(ipHash, project.id, deps);
    if (!limit.ok) {
      return json(
        { error: 'rate_limited', reason: limit.reason, retryAfterSec: limit.retryAfterSec },
        429,
        { 'retry-after': String(limit.retryAfterSec) },
      );
    }
    prepared = { db, project, deps, window, liveRunId: limit.liveRunId };
  } catch (e) {
    console.error('shift.live failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }

  const { db, project, deps, window, liveRunId } = prepared;
  try {
    const enc = new TextEncoder();
    let closed = false;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const write = (chunk: string) => {
      if (closed) return;
      try {
        ctrl.enqueue(enc.encode(chunk));
      } catch {
        closed = true;
      }
    };
    const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; },
      cancel() { closed = true; },
    });
    req.signal?.addEventListener('abort', () => { closed = true; });

    write(': lights on\n\n');
    const ping = setInterval(() => write(': ping\n\n'), PING_MS);
    const run = runProject(project.id, 'live', window, deps, (s) => send('step', s), { liveRunId })
      .then((r) => send('done', donePayload(r)))
      .catch((e) => {
        console.error('shift.live run failed:', safeErrorCode(e));
        send('done', donePayload(null));
      })
      .finally(() => {
        clearInterval(ping);
        if (!closed) {
          closed = true;
          try { ctrl.close(); } catch { /* already closed */ }
        }
      });
    after(run); // a dropped client does not cut the run short (limits were already charged)
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (e) {
    console.error('shift.live failed:', safeErrorCode(e));
    await updateLiveRun(db, liveRunId, { status: 'failed' }).catch(() => undefined);
    return json({ error: 'internal' }, 500);
  }
}
