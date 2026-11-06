import { createPublicClient, formatEther, getAddress, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import type { Db } from '@/lib/db';
import { getLatestFinishedNightly, getNightsForProjects } from '@/lib/db/queries';
import { discoverBacker, parseAddress, type BackerDeps, type BackerProject } from '@/lib/backer';
import { buildBriefing, gatherBriefingProjects } from '@/lib/notify/briefing';
import { computeRecord } from '@/lib/shift/rules';
import { nightDate, nightNumber, nightOf, shiftStartFor, utcDay } from '@/lib/shift/night';
import { safeErrorCode } from '@/lib/net/redact';
import type { Status } from '@/lib/types';

export type ResolvedBacker = { address: Address; ens: string | null } | { error: 'invalid_address' | 'ens_unavailable' | 'ens_not_found' };

const ENS_NAME = /^[^\s/]{1,200}\.eth$/i;

/** A 0x address as is; an ENS name through ETH_RPC_URL (ccipRead off), when that is configured. */
export async function resolveBacker(raw: string): Promise<ResolvedBacker> {
  const a = parseAddress(raw);
  if (a) return { address: a, ens: null };
  if (!ENS_NAME.test(raw)) return { error: 'invalid_address' };
  const url = process.env.ETH_RPC_URL;
  if (!url) return { error: 'ens_unavailable' };
  let name: string;
  try {
    name = normalize(raw);
  } catch {
    return { error: 'invalid_address' };
  }
  try {
    const client = createPublicClient({ chain: mainnet, ccipRead: false, transport: http(url, { timeout: 10_000 }) });
    const resolved = await client.getEnsAddress({ name });
    return resolved ? { address: getAddress(resolved), ens: name } : { error: 'ens_not_found' };
  } catch (e) {
    console.error('ens failed:', safeErrorCode(e));
    return { error: 'ens_unavailable' };
  }
}

export interface BackedProject {
  slug: string;
  name: string;
  via: BackerProject['via'];
  /** Contribution in ETH (Vibestarter escrows take ETH); null when none was found. */
  contributedEth: string | null;
  refundClaimed: boolean;
  /** Token balance as reported, or the raw integer when decimals() could not be read. */
  balance: string | null;
  symbol: string | null;
  status: Status | null;
  statusNight: number | null;
  statusObserved: boolean;
  lit30: number;
}

export interface BackerView {
  address: Address;
  displayName: string | null;
  degraded: boolean;
  projects: BackedProject[];
  briefing: string;
  /** The night the briefing describes (latest finished live shift), or null before the first one. */
  briefingNight: number | null;
}

/** Projects a wallet backed or holds, each with its latest reading, plus the morning briefing (template, no AI). */
export async function getBackerView(db: Db, address: Address, deps: Partial<BackerDeps> = {}, now = new Date()): Promise<BackerView> {
  const found = await discoverBacker(address, { ...deps, db });
  const ids = found.projects.map((p) => p.id);
  const lastNight = nightNumber(shiftStartFor(now));
  const from = nightDate(nightNumber(new Date(shiftStartFor(now).getTime() - 31 * 86_400_000)));
  const [rows, latest] = await Promise.all([
    ids.length ? getNightsForProjects(db, ids, from) : Promise.resolve([]),
    getLatestFinishedNightly(db),
  ]);

  const projects: BackedProject[] = found.projects.map((p) => {
    const mine = rows.filter((r) => r.projectId === p.id);
    const byNight = new Map<number, { status: Status; observed: boolean }>();
    for (const r of mine) {
      const n = nightOf(r.night);
      const prev = byNight.get(n);
      if (!prev || (r.observed && !prev.observed)) byNight.set(n, { status: r.status, observed: r.observed });
    }
    const newest = [...byNight.keys()].sort((a, b) => b - a)[0];
    const latestObs = [...byNight.entries()].filter(([, v]) => v.observed).sort((a, b) => b[0] - a[0])[0];
    const pick = latestObs ?? (newest !== undefined ? [newest, byNight.get(newest)!] as const : undefined);
    const rec = computeRecord([...byNight.entries()].map(([night, v]) => ({ night, status: v.status })), lastNight);
    return {
      slug: p.slug,
      name: p.name,
      via: p.via,
      contributedEth: p.amountWei && p.amountWei !== '0' ? formatEther(BigInt(p.amountWei)) : null,
      refundClaimed: p.refundClaimed === true,
      balance: p.balance ?? p.balanceRaw ?? null,
      symbol: p.symbol || null,
      status: pick ? pick[1].status : null,
      statusNight: pick ? pick[0] : null,
      statusObserved: pick ? pick[1].observed : false,
      lit30: rec.lit30,
    };
  });

  const night = latest?.night ?? utcDay(now);
  const input = ids.length ? await gatherBriefingProjects(db, ids, night, now) : [];
  const briefing = await buildBriefing({ projects: input, date: nightNumber(new Date(`${night}T00:00:00Z`)) });
  return {
    address,
    displayName: found.displayName ?? null,
    degraded: found.degraded,
    projects,
    briefing: ids.length ? briefing.text : '',
    briefingNight: latest ? nightOf(latest.night) : null,
  };
}

/** Telegram deep-link token: base64url of {"a": address}, the shape the bot's /start decodes. */
export function telegramStartToken(address: string): string {
  return Buffer.from(JSON.stringify({ a: address }), 'utf8').toString('base64url');
}

/** "0x60bc…e345" */
export const shortAddress = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
