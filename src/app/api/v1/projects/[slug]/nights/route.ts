import { getDb } from '@/lib/db';
import { canonicalRedirect, fail, nightParam, ok, preflight } from '@/lib/api';
import { cachedRead } from '@/lib/apiCache';
import { getProjectNights } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

/** `?from=yyyymmdd&to=yyyymmdd`, default the last 90 nights. Other params are redirected away (canonical order). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const q = new URL(req.url).searchParams;
    const range = { from: nightParam(q.get('from')), to: nightParam(q.get('to')) };
    const canon: [string, string][] = [];
    if (range.from !== undefined) canon.push(['from', String(range.from)]);
    if (range.to !== undefined) canon.push(['to', String(range.to)]);
    const redirect = canonicalRedirect(req, canon);
    if (redirect) return redirect;
    const slug = (await ctx.params).slug;
    const key = `nights:${slug}:${range.from ?? ''}:${range.to ?? ''}`;
    return ok(await cachedRead(key, req.headers, async () => getProjectNights(await getDb(), slug, range)));
  } catch (e) {
    return fail(e);
  }
}
