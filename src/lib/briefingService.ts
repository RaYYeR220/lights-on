import { createPublicClient, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import type { Db } from '@/lib/db';
import { getLatestFinishedNightly } from '@/lib/db/queries';
import { safeErrorCode } from '@/lib/net/redact';
import { discoverBacker, parseAddress, routeDeps } from '@/lib/backer';
import { buildBriefing, gatherBriefingProjects } from '@/lib/notify/briefing';
import { nightNumber, utcDay } from '@/lib/shift/night';

const ENS_NAME = /^[^\s/]{1,200}\.eth$/i;

export type ResolvedAddress = { address: ReturnType<typeof getAddress> } | { error: string; status: number };

/** Wallet address or ENS name -> checksummed address (fixed error codes otherwise). */
export async function resolveAddressInput(raw: string): Promise<ResolvedAddress> {
  const a = parseAddress(raw);
  if (a) return { address: a };
  if (!ENS_NAME.test(raw)) return { error: 'invalid_address', status: 400 };
  const url = process.env.ETH_RPC_URL;
  if (!url) return { error: 'ens_unavailable', status: 400 };
  try {
    let name: string;
    try {
      name = normalize(raw);
    } catch {
      return { error: 'invalid_address', status: 400 };
    }
    // ccipRead off: a resolver must not be able to make this server fetch URLs of its choosing.
    const client = createPublicClient({ chain: mainnet, ccipRead: false, transport: http(url, { timeout: 10_000 }) });
    const resolved = await client.getEnsAddress({ name });
    return resolved ? { address: getAddress(resolved) } : { error: 'ens_not_found', status: 404 };
  } catch (e) {
    console.error('ens failed:', safeErrorCode(e));
    return { error: 'ens_unavailable', status: 503 };
  }
}

/** The /api/v1/briefing/[address] body for a resolved address (shared by REST and MCP `get_briefing`). */
export async function briefingFor(db: Db | undefined, address: string) {
  const override = routeDeps();
  const useDb = override?.db ?? db;
  if (!useDb) throw new Error('db_required');
  const found = await discoverBacker(address, { ...override, db: useDb });

  const now = new Date();
  const latest = await getLatestFinishedNightly(useDb);
  const night = latest?.night ?? utcDay(now);
  const input = await gatherBriefingProjects(useDb, found.projects.map((p) => p.id), night, now);
  const briefing = await buildBriefing({ projects: input, date: nightNumber(new Date(`${night}T00:00:00Z`)) });

  return {
    address,
    projects: found.projects.map(({ id: _id, ...p }) => p),
    briefing: { text: briefing.text, aiOk: false },
    ...(found.displayName ? { displayName: found.displayName } : {}),
    degraded: found.degraded,
  };
}
