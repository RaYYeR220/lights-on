import { getDb } from '@/lib/db';
import { fail, ok, preflight } from '@/lib/api';
import { listProjects } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

/** `?with=lastNight,history`: lastNight fields are always present; `history` adds 90 daily statuses (oldest first). */
export async function GET(req: Request): Promise<Response> {
  try {
    const withs = (new URL(req.url).searchParams.get('with') ?? '').split(',').map((s) => s.trim());
    return ok(await listProjects(await getDb(), { history: withs.includes('history') }));
  } catch (e) {
    return fail(e);
  }
}
