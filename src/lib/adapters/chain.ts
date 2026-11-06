import { safeFetch, type SafeFetchResult } from '@/lib/net/safeFetch';
import type { AdapterResult, ChainFacts, TimeWindow } from '@/lib/types';

export const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const BASE_CHAIN_ID = 8453;
export const MAX_PAGES = 3;

export type FetchFn = (url: string) => Promise<SafeFetchResult>;
export interface ChainDeps {
  fetch?: FetchFn;
}

export const defaultFetch: FetchFn = (u) => safeFetch(u);

/**
 * Walks a Blockscout v2 paginated list (newest first). `pastWindow(items)` returns true when the page already
 * contains an entry older than the window start, which ends the walk. Throws on non-JSON / non-2xx.
 */
export async function fetchBlockscoutPages(
  doFetch: FetchFn,
  url: string,
  pastWindow: (items: Record<string, unknown>[]) => boolean,
  maxPages = MAX_PAGES,
): Promise<{ items: Record<string, unknown>[]; calls: number }> {
  const all: Record<string, unknown>[] = [];
  let next: Record<string, unknown> | null = null;
  let calls = 0;
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
  }
  return { items: all, calls };
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const addrOf = (v: unknown): string | null =>
  v && typeof v === 'object' && typeof (v as { hash?: unknown }).hash === 'string' ? (v as { hash: string }).hash : null;

function txPastWindow(startMs: number) {
  return (items: Record<string, unknown>[]) => items.some((t) => ms(t.timestamp) < startMs);
}

/**
 * Nightly on-chain activity of listed Base contracts plus contract creations by the deployer inside the window.
 * Blockscout v2 REST (not eth_getLogs on a public RPC). Never throws.
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
  const inWindow = (t: unknown) => {
    const v = ms(t);
    return v >= startMs && v < endMs;
  };
  const facts: ChainFacts = { contracts: [], newDeployments: [], holderDelta: null };
  const errors: string[] = [];
  let calls = 0;
  let attempted = 0;

  for (const c of contracts) {
    if (c.chainId !== BASE_CHAIN_ID) {
      errors.push(`chain ${c.chainId} unsupported`);
      continue;
    }
    attempted++;
    try {
      const r = await fetchBlockscoutPages(doFetch, `${BLOCKSCOUT_BASE}/addresses/${c.address}/transactions`, txPastWindow(startMs));
      calls += r.calls;
      const txs = r.items.filter((t) => inWindow(t.timestamp));
      const senders = new Set(txs.map((t) => addrOf(t.from)?.toLowerCase()).filter((x): x is string => !!x));
      facts.contracts.push({ chainId: c.chainId, address: c.address, txCount: txs.length, uniqueSenders: senders.size });
    } catch (e) {
      errors.push(`${c.address}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (deployer) {
    attempted++;
    try {
      const r = await fetchBlockscoutPages(doFetch, `${BLOCKSCOUT_BASE}/addresses/${deployer}/transactions?filter=from`, txPastWindow(startMs));
      calls += r.calls;
      for (const t of r.items) {
        const created = addrOf(t.created_contract);
        if (!created || !inWindow(t.timestamp)) continue;
        if (addrOf(t.from)?.toLowerCase() !== deployer.toLowerCase()) continue;
        facts.newDeployments.push({ address: created, txHash: String(t.hash), at: String(t.timestamp) });
      }
    } catch (e) {
      errors.push(`deployer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const done = facts.contracts.length + (deployer && !errors.some((e) => e.startsWith('deployer')) ? 1 : 0);
  if (attempted > 0 && done === 0) return { source: 'chain', tier: 'verified', ok: false, facts: null, error: errors.join('; '), calls };
  return {
    source: 'chain',
    tier: 'verified',
    ok: true,
    ...(errors.length ? { degraded: true, error: errors.join('; ') } : {}),
    facts,
    calls,
  };
}
