import { createPublicClient, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { getDb } from '@/lib/db';
import { getLatestFinishedNightly } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { discoverBacker, parseAddress, routeDeps } from '@/lib/backer';
import { buildBriefing, gatherBriefingProjects } from '@/lib/notify/briefing';
import { nightNumber, utcDay } from '@/lib/shift/night';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE = { 'cache-control': 'public, s-maxage=300' };
const ENS_NAME = /^[^\s/]{1,200}\.eth$/i;

type Resolved = { address: ReturnType<typeof getAddress> } | { error: string; status: number };

async function resolveInput(raw: string): Promise<Resolved> {
  const a = parseAddress(raw);
  if (a) return { address: a };
  if (!ENS_NAME.test(raw)) return { error: 'invalid_address', status: 400 };
  const url = process.env.ETH_RPC_URL;
  if (!url) return { error: 'ens_unavailable', status: 400 };
  try {
    const client = createPublicClient({ chain: mainnet, transport: http(url, { timeout: 10_000 }) });
    const resolved = await client.getEnsAddress({ name: normalize(raw) });
    return resolved ? { address: getAddress(resolved) } : { error: 'ens_not_found', status: 404 };
  } catch (e) {
    console.error('ens failed:', safeErrorCode(e));
    return { error: 'ens_unavailable', status: 400 };
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }): Promise<Response> {
  try {
    const raw = decodeURIComponent((await ctx.params).address ?? '').trim();
    const r = await resolveInput(raw);
    if ('error' in r) return json({ error: r.error }, r.status);

    const override = routeDeps();
    const db = override?.db ?? (await getDb());
    const found = await discoverBacker(r.address, { ...override, db });

    const now = new Date();
    const latest = await getLatestFinishedNightly(db);
    const night = latest?.night ?? utcDay(now);
    const input = await gatherBriefingProjects(db, found.projects.map((p) => p.id), night, now);
    const briefing = await buildBriefing({ projects: input, date: nightNumber(new Date(`${night}T00:00:00Z`)) });

    return json({
      address: r.address,
      projects: found.projects.map(({ id: _id, ...p }) => p),
      briefing: { text: briefing.text, aiOk: false },
      degraded: found.degraded,
    }, 200, CACHE);
  } catch (e) {
    console.error('briefing route failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
