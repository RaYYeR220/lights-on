import { getDb } from '@/lib/db';
import { fail, ok, preflight } from '@/lib/api';
import { getProject } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    return ok(await getProject(await getDb(), (await ctx.params).slug));
  } catch (e) {
    return fail(e);
  }
}
