import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { getProjectBySlug } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { makeShiftDeps } from '@/lib/shift/deps';
import { maybeFinalizeStale } from '@/lib/shift/finalize';
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
    txHash: a && 'uid' in a ? a.txHash : null,
    attestSkipped: a && 'skipped' in a ? a.skipped : null,
    ...(r ? {} : { error: 'run_failed' }),
  };
}

/** Live shift for one project, streamed as SSE: `event: step` (Step JSON) ... then one `event: done`. */
export async function GET(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get('project') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'bad_project' }, 400);

  let prepared;
  try {
    const db = await getDb();
    const project = await getProjectBySlug(db, slug);
    if (!project) return json({ error: 'not_found' }, 404);
    const deps = makeShiftDeps(db, { kind: 'live' });
    const now = deps.now();
    // Stuck-shift guard; runs alongside (never touches what a live run writes), kept alive past the response.
    after(maybeFinalizeStale(deps).catch(() => 0));
    const ipHash = hashIp(clientIp(req.headers), utcDay(now), process.env.INTERNAL_RUN_TOKEN ?? '');
    const limit = await checkLiveLimit(ipHash, project.id, deps);
    if (!limit.ok) {
      return json(
        { error: 'rate_limited', reason: limit.reason, retryAfterSec: limit.retryAfterSec },
        429,
        { 'retry-after': String(limit.retryAfterSec) },
      );
    }
    prepared = { project, deps, liveRunId: limit.liveRunId, window: await liveWindow(db, project.id, now) };
  } catch (e) {
    console.error('shift.live failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }

  const { project, deps, liveRunId, window } = prepared;
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
}
