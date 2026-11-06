import { getDb } from '@/lib/db';
import { fail, nightParam, ok, preflight } from '@/lib/api';
import { getProjectNights } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

/** `?from=yyyymmdd&to=yyyymmdd`, default the last 90 nights. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const q = new URL(req.url).searchParams;
    const range = { from: nightParam(q.get('from')), to: nightParam(q.get('to')) };
    return ok(await getProjectNights(await getDb(), (await ctx.params).slug, range));
  } catch (e) {
    return fail(e);
  }
}
