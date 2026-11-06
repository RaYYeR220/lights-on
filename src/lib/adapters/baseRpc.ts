import { createPublicClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import type { TimeWindow } from '@/lib/types';

export interface RpcLog {
  address?: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
}

/** The narrow slice of a viem PublicClient this module needs; tests inject a fake. */
export interface RpcLike {
  getBlock(args: { blockNumber?: bigint; blockTag?: 'latest' }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getLogs(args: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<RpcLog[]>;
}

export const DEFAULT_BASE_RPC = 'https://base-rpc.publicnode.com';

/**
 * Exception to the "all outbound HTTP via safeFetch" rule: this is a fixed, operator-configured endpoint
 * (BASE_RPC_URL or the publicnode default), never derived from user input, so there is no SSRF surface.
 */
export function getBaseClient(): RpcLike {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? DEFAULT_BASE_RPC, { timeout: 10_000, retryCount: 2 }),
  });
  return client as unknown as RpcLike;
}

export interface BlockAtTime {
  block: bigint;
  /** false when the chain head is older than the requested time (block is then the head). */
  reached: boolean;
  calls: number;
}

/**
 * First block whose timestamp is >= unixSec. Latest block, then interpolation search between known
 * (block, timestamp) bounds, falling back to bisection whenever interpolation fails to halve the bracket.
 * Robust to block-time changes (Base moved from 2 s to 200 ms blocks on 5 Nov 2026). Throws past `maxCalls`.
 */
export async function blockAtTimeInfo(client: RpcLike, unixSec: number, maxCalls = 24): Promise<BlockAtTime> {
  let calls = 0;
  const get = async (a: { blockNumber?: bigint; blockTag?: 'latest' }) => {
    if (++calls > maxCalls) throw new Error('blockAtTime: call budget exceeded');
    return client.getBlock(a);
  };
  const U = BigInt(Math.floor(unixSec));
  const latest = await get({ blockTag: 'latest' });
  const L = latest.number ?? 0n;
  if (latest.timestamp < U) return { block: L, reached: false, calls };
  if (L === 0n) return { block: 0n, reached: true, calls };
  // Lower bracket: ~1M blocks back (about 2 days at 5 blocks/s). Not genesis: non-archive public RPCs refuse old blocks (publicnode retains between 1.5M and 3M).
  let hi = L;
  let thi = latest.timestamp;
  let back = 1_000_000n;
  let lo = L > back ? L - back : 0n;
  let tlo = (await get({ blockNumber: lo })).timestamp;
  while (tlo >= U) {
    if (lo === 0n) return { block: 0n, reached: true, calls };
    hi = lo;
    thi = tlo;
    back *= 2n;
    lo = L > back ? L - back : 0n;
    tlo = (await get({ blockNumber: lo })).timestamp;
  }
  let bisect = false;
  while (hi - lo > 1n) {
    const width = hi - lo;
    let mid: bigint;
    if (!bisect && thi > tlo) {
      mid = lo + ((U - tlo) * width) / (thi - tlo);
      if (mid <= lo) mid = lo + 1n;
      if (mid >= hi) mid = hi - 1n;
    } else {
      mid = lo + width / 2n;
    }
    const b = await get({ blockNumber: mid });
    if (b.timestamp >= U) {
      hi = mid;
      thi = b.timestamp;
    } else {
      lo = mid;
      tlo = b.timestamp;
    }
    bisect = (hi - lo) * 2n > width;
  }
  return { block: hi, reached: true, calls };
}

export async function blockAtTime(client: RpcLike, unixSec: number): Promise<bigint> {
  return (await blockAtTimeInfo(client, unixSec)).block;
}

/** Inclusive block range covering [window.start, window.end). Empty (to < from) if nothing falls in it. */
export async function windowBlocks(
  client: RpcLike,
  window: TimeWindow,
): Promise<{ fromBlock: bigint; toBlock: bigint; calls: number }> {
  const s = await blockAtTimeInfo(client, Date.parse(window.start) / 1000);
  const e = await blockAtTimeInfo(client, Date.parse(window.end) / 1000);
  const toBlock = e.reached ? e.block - 1n : e.block;
  return { fromBlock: s.block, toBlock, calls: s.calls + e.calls };
}

export interface ChunkedLogs {
  logs: RpcLog[];
  calls: number;
  truncated: boolean;
}

/** Sequential eth_getLogs over [fromBlock, toBlock] in `chunk`-sized slices; stops after `maxChunks` and flags truncated. */
export async function getLogsChunked(
  client: RpcLike,
  args: { address: Hex; fromBlock: bigint; toBlock: bigint; chunk?: bigint; maxChunks?: number },
): Promise<ChunkedLogs> {
  const chunk = args.chunk ?? 50_000n;
  const maxChunks = args.maxChunks ?? 12;
  const logs: RpcLog[] = [];
  let calls = 0;
  let from = args.fromBlock;
  while (from <= args.toBlock) {
    if (calls >= maxChunks) return { logs, calls, truncated: true };
    const to = from + chunk - 1n < args.toBlock ? from + chunk - 1n : args.toBlock;
    logs.push(...(await client.getLogs({ address: args.address, fromBlock: from, toBlock: to })));
    calls++;
    from = to + 1n;
  }
  return { logs, calls, truncated: false };
}
