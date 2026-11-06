import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from 'viem';
import type { Db } from '@/lib/db';
import type { ProjectRow } from '@/lib/db/schema';
import { listProjects } from '@/lib/db/queries';
import { getBaseClient } from '@/lib/adapters/baseRpc';
import { safeFetch, type SafeFetchResult } from '@/lib/net/safeFetch';
import { vibestarterContributionsAbi } from '@/lib/adapters/vibestarterAbi';
import { safeErrorCode } from '@/lib/net/redact';

const API = 'https://app.vibestarter.xyz';
const BASE_CHAIN_ID = 8453;
const CACHE_MS = 10 * 60_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export type BackerFetch = (url: string) => Promise<SafeFetchResult>;
/** The slice of a viem PublicClient used for the token multicall; tests inject a fake. */
export interface MulticallLike {
  multicall(args: {
    contracts: ({ address: Address; abi: typeof erc20Abi; functionName: 'balanceOf' | 'decimals'; args?: [Address] }
      | { address: Address; abi: typeof vibestarterContributionsAbi; functionName: 'contributions'; args: [Address] })[];
    allowFailure: true;
  }): Promise<({ status: 'success'; result: unknown } | { status: 'failure'; error: unknown })[]>;
}

export interface BackerDeps {
  db: Db;
  /** Pre-loaded watched projects (batch callers load them once). */
  projects?: ProjectRow[];
  client?: MulticallLike;
  fetch?: BackerFetch;
  now?: () => number;
}

export interface BackerProject {
  id: number;
  slug: string;
  name: string;
  via: 'vibestarter' | 'token' | 'follow';
  amountWei?: string;
  refundClaimed?: boolean;
  /** Formatted token balance; null when decimals() could not be read (then see balanceRaw). */
  balance?: string | null;
  balanceRaw?: string;
  symbol?: string;
}
export interface BackerResult { projects: BackerProject[]; degraded: boolean; displayName?: string }

export interface Backing { campaignId: string; campaignTitle: string; amountWei: string }
export interface VibestarterIndex {
  /** lowercase wallet -> backings, summed per campaign. `campaignId` is the campaign's launch tx hash (what /api/backings/recent calls its id). */
  byWallet: Map<string, Backing[]>;
  /** lowercase wallet -> display name (enrichment only). */
  names: Map<string, string>;
  /** token.launchTxHash (lowercase) -> campaign cuid (what projects.vibestarter.campaignId stores), from /api/campaigns. */
  launchToCuid: Map<string, string>;
  /** /api/campaigns failed: mapping fell back to titles; this index is not cached. */
  launchMapFailed?: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function getJson(doFetch: BackerFetch, url: string): Promise<unknown> {
  const res = await doFetch(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`http_${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('invalid_json');
  }
}

let cache: { at: number; idx: VibestarterIndex } | null = null;
let inflight: Promise<VibestarterIndex> | null = null;
export function resetBackerCache(): void { cache = null; inflight = null; }

/** Campaign launch tx hash -> cuid. ok=false on failure (title match still works, caller reports degraded). */
async function loadLaunchMap(doFetch: BackerFetch): Promise<{ map: Map<string, string>; ok: boolean }> {
  const map = new Map<string, string>();
  try {
    const j = await getJson(doFetch, `${API}/api/campaigns?limit=50`);
    if (isRec(j) && Array.isArray(j.campaigns)) {
      for (const c of j.campaigns) {
        if (!isRec(c)) continue;
        const id = str(c.id);
        const launch = isRec(c.token) ? str(c.token.launchTxHash) : null;
        if (id && launch) map.set(launch.toLowerCase(), id);
      }
    }
  } catch { return { map, ok: false }; }
  return { map, ok: true };
}

/** Throws (fixed code) when the backings endpoint fails; the caller marks the result degraded. */
export async function loadVibestarterIndex(deps: { fetch?: BackerFetch; now?: () => number } = {}): Promise<VibestarterIndex> {
  const now = (deps.now ?? Date.now)();
  if (cache && now - cache.at < CACHE_MS) return cache.idx;
  // Concurrent cold requests share one crawl.
  if (inflight) return inflight;
  const p = crawlIndex(deps, now).finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

async function crawlIndex(deps: { fetch?: BackerFetch }, now: number): Promise<VibestarterIndex> {
  const doFetch = deps.fetch ?? ((u) => safeFetch(u));
  const seen = new Set<string>();
  const names = new Map<string, string>();
  const sums = new Map<string, Map<string, Backing>>();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await getJson(doFetch, `${API}/api/backings/recent?limit=${PAGE_LIMIT}&offset=${offset}`);
    const items = isRec(j) && Array.isArray(j.backings) ? j.backings.filter(isRec) : [];
    let fresh = 0;
    for (const b of items) {
      const id = str(b.id);
      const amount = str(b.amount);
      const wallet = isRec(b.backer) ? str(b.backer.wallet)?.toLowerCase() : null;
      const camp = isRec(b.campaign) ? b.campaign : null;
      const cid = camp ? str(camp.id)?.toLowerCase() : null;
      if (!id || seen.has(id) || !amount || !/^\d+$/.test(amount) || !wallet || !cid || !camp) continue;
      seen.add(id);
      const dn = isRec(b.backer) ? str(b.backer.displayName) : null;
      if (dn) names.set(wallet, dn);
      fresh++;
      const perWallet = sums.get(wallet) ?? new Map<string, Backing>();
      const cur = perWallet.get(cid);
      perWallet.set(cid, {
        campaignId: cid,
        campaignTitle: str(camp.title) ?? '',
        amountWei: (BigInt(cur?.amountWei ?? '0') + BigInt(amount)).toString(),
      });
      sums.set(wallet, perWallet);
    }
    // The live endpoint caps a page at 50 and ignores `offset` (a repeat page has nothing new): stop then.
    if (items.length === 0 || fresh === 0) break;
    offset += items.length;
  }
  const byWallet = new Map([...sums].map(([w, m]) => [w, [...m.values()]] as [string, Backing[]]));
  const launch = await loadLaunchMap(doFetch);
  const idx: VibestarterIndex = { byWallet, names, launchToCuid: launch.map, ...(launch.ok ? {} : { launchMapFailed: true }) };
  if (launch.ok) cache = { at: now, idx };
  return idx;
}

/** Normalises a checksummed or lowercase 0x address; null when invalid. */
export function parseAddress(raw: string): Address | null {
  return isAddress(raw, { strict: true }) ? getAddress(raw) : null; // mixed case must carry a valid checksum
}

export async function discoverBacker(address: string, deps: BackerDeps): Promise<BackerResult> {
  const addr = parseAddress(address);
  if (!addr) return { projects: [], degraded: false };
  const wallet = addr.toLowerCase();
  const projs = deps.projects ?? (await listProjects(deps.db));
  const out = new Map<number, BackerProject>();
  let degraded = false;

  const client = deps.client ?? (getBaseClient() as unknown as MulticallLike);
  // 1. On-chain escrow contributions: authoritative (the REST API lags and is truncated).
  const escrowed = projs.filter((p) => p.vibestarter?.escrow && isAddress(p.vibestarter.escrow, { strict: false }));
  const onchain = new Set<number>();
  if (escrowed.length) {
    try {
      const res = await client.multicall({
        allowFailure: true,
        contracts: escrowed.map((p) => ({
          address: p.vibestarter!.escrow as Address, abi: vibestarterContributionsAbi, functionName: 'contributions' as const, args: [addr] as [Address],
        })),
      });
      escrowed.forEach((p, i) => {
        const r = res[i];
        if (r.status !== 'success' || !Array.isArray(r.result) || typeof r.result[0] !== 'bigint') {
          degraded = true; // this project's chain read failed -> REST fallback below
          return;
        }
        onchain.add(p.id);
        if (r.result[0] > 0n) {
          out.set(p.id, { id: p.id, slug: p.slug, name: p.name, via: 'vibestarter', amountWei: r.result[0].toString(), refundClaimed: r.result[1] === true });
        }
      });
    } catch (e) {
      degraded = true;
      console.error('backer.escrow failed:', safeErrorCode(e));
    }
  }

  // 2. REST index: display-name enrichment, and the fallback for projects the chain read did not cover. Never degrades.
  let displayName: string | undefined;
  try {
    const idx = await loadVibestarterIndex(deps);
    displayName = idx.names.get(wallet);
    if (idx.launchMapFailed) degraded = true;
    for (const b of idx.byWallet.get(wallet) ?? []) {
      const cuid = idx.launchToCuid.get(b.campaignId);
      const title = b.campaignTitle.trim().toLowerCase();
      const p = projs.find((x) => cuid && x.vibestarter?.campaignId === cuid)
        ?? (title ? projs.find((x) => x.name.trim().toLowerCase() === title) : undefined);
      if (!p || onchain.has(p.id)) continue;
      const prev = out.get(p.id);
      const amount = (BigInt(prev?.amountWei ?? '0') + BigInt(b.amountWei)).toString();
      out.set(p.id, { id: p.id, slug: p.slug, name: p.name, via: 'vibestarter', amountWei: amount });
    }
  } catch (e) {
    console.error('backer.rest failed:', safeErrorCode(e));
  }

  const held = projs.filter((p) => p.token && p.token.chainId === BASE_CHAIN_ID && isAddress(p.token.address, { strict: false }));
  if (held.length) {
    try {
      const res = await client.multicall({
        allowFailure: true,
        contracts: held.flatMap((p) => [
          { address: p.token!.address as Address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [addr] as [Address] },
          { address: p.token!.address as Address, abi: erc20Abi, functionName: 'decimals' as const },
        ]),
      });
      held.forEach((p, i) => {
        const bal = res[i * 2];
        const dec = res[i * 2 + 1];
        if (bal.status !== 'success' || typeof bal.result !== 'bigint') {
          degraded = true;
          return;
        }
        if (bal.result === 0n) return;
        // Never assume 18 decimals: without decimals() report the raw amount only.
        const decimalsOk = dec.status === 'success' && typeof dec.result === 'number';
        if (!decimalsOk) degraded = true;
        const fields = decimalsOk
          ? { balance: formatUnits(bal.result, dec.result as number) }
          : { balance: null, balanceRaw: bal.result.toString() };
        const prev = out.get(p.id);
        out.set(p.id, prev
          ? { ...prev, ...fields, symbol: p.token!.symbol }
          : { id: p.id, slug: p.slug, name: p.name, via: 'token', ...fields, symbol: p.token!.symbol });
      });
    } catch (e) {
      degraded = true;
      console.error('backer.token failed:', safeErrorCode(e));
    }
  }
  return { projects: [...out.values()].sort((a, b) => a.id - b.id), degraded, ...(displayName ? { displayName } : {}) };
}

/** Plug for `onShiftFinalized({ resolveAddresses })`: project ids for a set of wallets; bad addresses and failures are skipped. */
export async function resolveBackerProjectIds(addresses: string[], deps: BackerDeps): Promise<number[]> {
  const ids = new Set<number>();
  const valid = [...new Set(addresses)].filter((a) => parseAddress(a));
  if (valid.length === 0) return [];
  const shared = { ...deps, projects: deps.projects ?? (await listProjects(deps.db)) }; // one project list for every address
  for (const a of valid) {
    try {
      for (const p of (await discoverBacker(a, shared)).projects) ids.add(p.id);
    } catch (e) {
      console.error('backer.resolve failed:', safeErrorCode(e));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

let routeOverride: BackerDeps | null = null;
/** Test seam for the route (db/fetch/client). */
export function setBackerDepsForTests(d: BackerDeps | null): void { routeOverride = d; }
export function routeDeps(): BackerDeps | null { return routeOverride; }
