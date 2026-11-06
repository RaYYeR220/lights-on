import { safeFetch, type SafeFetchResult } from '@/lib/net/safeFetch';
import type { AdapterResult, ChainFacts, TimeWindow } from '@/lib/types';
import { getBaseClient, getLogsChunked, windowBlocks, type RpcLike } from '@/lib/adapters/baseRpc';

export const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const BASE_CHAIN_ID = 8453;
export const MAX_PAGES = 3;

export type FetchFn = (url: string) => Promise<SafeFetchResult>;
export interface ChainDeps {
  /** Blockscout REST (deployer creations only). */
  fetch?: FetchFn;
  /** Base RPC client; defaults to getBaseClient(). */
  client?: RpcLike;
}

export const defaultFetch: FetchFn = (u) => safeFetch(u);

/**
 * Walks a Blockscout v2 paginated list (newest first). `pastWindow(items)` returns true when the page already
 * contains an entry older than the window start, which ends the walk. `truncated` is true when the page cap was
 * hit while more pages (still inside the window) remained. Throws on non-JSON / non-2xx.
 */
export async function fetchBlockscoutPages(
  doFetch: FetchFn,
  url: string,
  pastWindow: (items: Record<string, unknown>[]) => boolean,
  maxPages = MAX_PAGES,
): Promise<{ items: Record<string, unknown>[]; calls: number; truncated: boolean }> {
  const all: Record<string, unknown>[] = [];
  let next: Record<string, unknown> | null = null;
  let calls = 0;
  let truncated = false;
  for (let p = 0; p < maxPages; p++) {
    let u = url;
    if (next) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) qs.set(k, String(v));
      u += (url.includes('?') ? '&' : '?') + qs.toString();
    }
    const res = await doFetch(u);
    calls++;
    if (res.status < 200 || res.status >= 300) throw new Error(`blockscout HTTP ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error('blockscout returned non-JSON');
    }
    const j = json as { items?: unknown; next_page_params?: unknown };
    if (!Array.isArray(j.items)) throw new Error('blockscout: unexpected shape');
    const items = j.items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    all.push(...items);
    next = j.next_page_params && typeof j.next_page_params === 'object' ? (j.next_page_params as Record<string, unknown>) : null;
    if (!next || pastWindow(items)) break;
    if (p === maxPages - 1) truncated = true;
  }
  return { items: all, calls, truncated };
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const addrOf = (v: unknown): string | null =>
  v && typeof v === 'object' && typeof (v as { hash?: unknown }).hash === 'string' ? (v as { hash: string }).hash : null;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Nightly on-chain activity. Per Base contract: distinct tx hashes among logs emitted in the window
 * (eth_getLogs over the window's exact block range; senders are not in logs, so uniqueSenders is null).
 * Deployer creations: Blockscout v2 REST, optional; when unavailable newDeployments is [] with
 * degraded + `blockscout_unavailable`. Any truncation sets degraded. Never throws.
 */
export async function checkChain(
  contracts: { chainId: number; address: string; role?: string }[],
  deployer: string | null,
  window: TimeWindow,
  deps: ChainDeps = {},
): Promise<AdapterResult<ChainFacts>> {
  const doFetch = deps.fetch ?? defaultFetch;
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const facts: ChainFacts = { contracts: [], newDeployments: [], holderDelta: null };
  const notes: string[] = [];
  let degraded = false;
  let calls = 0;
  let attempted = 0;
  let succeeded = 0;

  const onBase = contracts.filter((c) => c.chainId === BASE_CHAIN_ID);
  for (const c of contracts) if (c.chainId !== BASE_CHAIN_ID) notes.push(`skipped_chain_${c.chainId}:${c.address}`);

  if (onBase.length > 0) {
    attempted += onBase.length;
    try {
      const client = deps.client ?? getBaseClient();
      const range = await windowBlocks(client, window);
      calls += range.calls;
      for (const c of onBase) {
        try {
          let txCount = 0;
          if (range.toBlock >= range.fromBlock) {
            const r = await getLogsChunked(client, {
              address: c.address as `0x${string}`,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
            });
            calls += r.calls;
            txCount = new Set(r.logs.map((l) => l.transactionHash).filter((h): h is `0x${string}` => !!h)).size;
            if (r.truncated) {
              degraded = true;
              notes.push(`logs_truncated:${c.address}`);
            }
          }
          facts.contracts.push({ chainId: c.chainId, address: c.address, txCount, uniqueSenders: null });
          succeeded++;
        } catch (e) {
          degraded = true;
          notes.push(`rpc_failed:${c.address}: ${msg(e)}`);
        }
      }
    } catch (e) {
      degraded = true;
      notes.push(`rpc_failed: ${msg(e)}`);
    }
  }

  if (deployer) {
    attempted++;
    try {
      const past = (items: Record<string, unknown>[]) => items.some((t) => ms(t.timestamp) < startMs);
      const r = await fetchBlockscoutPages(doFetch, `${BLOCKSCOUT_BASE}/addresses/${deployer}/transactions?filter=from`, past);
      calls += r.calls;
      for (const t of r.items) {
        const created = addrOf(t.created_contract);
        const at = ms(t.timestamp);
        if (!created || !(at >= startMs && at < endMs)) continue;
        if (addrOf(t.from)?.toLowerCase() !== deployer.toLowerCase()) continue;
        facts.newDeployments.push({ address: created, txHash: String(t.hash), at: String(t.timestamp) });
      }
      if (r.truncated) {
        degraded = true;
        notes.push('deployer_txs_truncated');
      }
      succeeded++;
    } catch {
      degraded = true;
      notes.push('blockscout_unavailable');
    }
  }

  const head = { source: 'chain' as const, tier: 'verified' as const, calls };
  if (attempted > 0 && succeeded === 0) return { ...head, ok: false, facts: null, error: notes.join('; ') };
  return {
    ...head,
    ok: true,
    ...(degraded ? { degraded: true } : {}),
    ...(notes.length ? { error: notes.join('; ') } : {}),
    facts,
  };
}
