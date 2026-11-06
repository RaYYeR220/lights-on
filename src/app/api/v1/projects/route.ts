import { getDb } from '@/lib/db';
import { canonicalRedirect, fail, ok, preflight } from '@/lib/api';
import { cachedRead } from '@/lib/apiCache';
import { listProjects } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

const WITH = ['lastNight', 'history'] as const;

/**
 * `?with=lastNight,history`: lastNight fields are always present; `history` adds the last 90 nights as a 90-letter
 * string. Any other query is redirected to its canonical form; answers come from the process cache (shared with MCP).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const asked = new Set((new URL(req.url).searchParams.get('with') ?? '').split(',').map((s) => s.trim()));
    const withs = WITH.filter((w) => asked.has(w));
    const redirect = canonicalRedirect(req, withs.length ? [['with', withs.join(',')]] : []);
    if (redirect) return redirect;
    const history = withs.includes('history');
    return ok(await cachedRead(`list:${history ? 'history' : 'plain'}`, req.headers, async () => listProjects(await getDb(), { history })));
  } catch (e) {
    return fail(e);
  }
}
