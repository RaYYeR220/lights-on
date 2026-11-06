import { getDb } from '@/lib/db';
import { json } from '@/lib/net/http';
import { CORS, fail, preflight } from '@/lib/api';
import { watchProject } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // the first shift runs after the response (after())

export const OPTIONS = preflight;

/** POST {liveUrl, repo?, contract?} -> {slug, status: 'queued'}. Rate-limited, SSRF-guarded; the project stays hidden until its first run succeeds. */
export async function POST(req: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400, CORS);
    }
    const r = await watchProject(await getDb(), body, { headers: req.headers });
    return json(r, 202, CORS);
  } catch (e) {
    return fail(e);
  }
}
