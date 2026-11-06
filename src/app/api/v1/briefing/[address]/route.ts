import { getDb } from '@/lib/db';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { parseAddress, routeDeps } from '@/lib/backer';
import { checkBriefingLimit } from '@/lib/briefingLimit';
import { briefingFor, resolveAddressInput } from '@/lib/briefingService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE = { 'cache-control': 'public, s-maxage=300' };
const CORS = { 'access-control-allow-origin': '*' };

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }): Promise<Response> {
  try {
    const wait = checkBriefingLimit(req.headers);
    if (wait !== null) return json({ error: 'rate_limited' }, 429, { 'retry-after': String(wait) });

    const param = (await ctx.params).address ?? '';
    let raw: string;
    try {
      raw = decodeURIComponent(param).trim();
    } catch {
      return json({ error: 'invalid_address' }, 400);
    }
    const r = await resolveAddressInput(raw);
    if ('error' in r) return json({ error: r.error }, r.status);
    // One cacheable URL per wallet: lowercase / unchecksummed input redirects to the checksummed path.
    if (parseAddress(raw) && raw !== r.address) {
      return new Response(null, { status: 308, headers: { location: `${new URL(req.url).origin}/api/v1/briefing/${r.address}`, 'cache-control': 'public, s-maxage=300' } });
    }

    const db = routeDeps()?.db ?? (await getDb());
    return json(await briefingFor(db, r.address), 200, { ...CACHE, ...CORS });
  } catch (e) {
    console.error('briefing route failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
