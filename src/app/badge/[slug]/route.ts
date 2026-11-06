import { getProjectBySlug, getNights } from '@/lib/db/queries';
import { renderBadge, renderNotWatched } from '@/lib/badge';
import { resolveClaimDeps } from '@/lib/claim';
import { nightNumber, nightOf } from '@/lib/shift/night';
import { computeRecord } from '@/lib/shift/rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const svg = (body: string, maxAge: number) =>
  new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` } });

/** Never errors: unknown, hidden or unreadable projects get the neutral badge. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const slug = decodeURIComponent((await ctx.params).slug ?? '');
    const deps = await resolveClaimDeps();
    const now = (deps.now ?? (() => new Date()))();
    const p = await getProjectBySlug(deps.db, slug);
    if (!p || p.hidden) return svg(renderNotWatched(), 600);
    const from = new Date(now.getTime() - 40 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getNights(deps.db, p.id, { from });
    if (rows.length === 0) return svg(renderNotWatched(), 600);
    const record = computeRecord(rows.map((r) => ({ night: nightOf(r.night), status: r.status })), nightNumber(now));
    const latest = [...rows].filter((r) => r.observed).pop() ?? rows[rows.length - 1];
    return svg(renderBadge(record, latest.status), 600);
  } catch {
    return svg(renderNotWatched(), 60);
  }
}
