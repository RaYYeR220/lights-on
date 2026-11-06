import { getDb } from '@/lib/db';
import { canonicalRedirect, fail, ok, preflight } from '@/lib/api';
import { cachedRead } from '@/lib/apiCache';
import { getProject } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const redirect = canonicalRedirect(req, []); // takes no query
    if (redirect) return redirect;
    const slug = (await ctx.params).slug;
    return ok(await cachedRead(`project:${slug}`, req.headers, async () => getProject(await getDb(), slug)));
  } catch (e) {
    return fail(e);
  }
}
