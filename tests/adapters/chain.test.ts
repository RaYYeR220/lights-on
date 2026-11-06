import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkChain } from '@/lib/adapters/chain';
import type { RpcLike, RpcLog } from '@/lib/adapters/baseRpc';
import type { SafeFetchResult } from '@/lib/net/safeFetch';

const fx = (n: string) => readFileSync(path.join(__dirname, '..', 'fixtures', 'blockscout', n), 'utf8');
const resp = (body: string, status = 200): SafeFetchResult => ({
  status,
  finalUrl: 'x',
  headers: new Headers(),
  body,
  truncated: false,
  latencyMs: 1,
});
const TOKEN = '0xce58d80d32ce44769bdcfcbf1227599ed126ee79';
const DEP = '0x' + 'de'.padStart(40, '0');
const window = { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' };
const START = BigInt(Date.parse(window.start) / 1000);

/** 10 min per block; block 100 is window.start, so the window is blocks [100, 244). */
const ts = (n: bigint) => START + (n - 100n) * 600n;
function client(logsFn: (from: bigint, to: bigint) => RpcLog[], opts: { failLogs?: boolean; failBlocks?: boolean } = {}) {
  const logCalls: [bigint, bigint][] = [];
  const c: RpcLike = {
    async getBlock({ blockNumber }) {
      if (opts.failBlocks) throw new Error('rpc down');
      const n = blockNumber ?? 400n;
      return { number: n, timestamp: ts(n) };
    },
    async getLogs({ fromBlock, toBlock }) {
      if (opts.failLogs) throw new Error('rpc down');
      logCalls.push([fromBlock, toBlock]);
      return logsFn(fromBlock, toBlock);
    },
  };
  return { c, logCalls };
}
const log = (block: bigint, tx: string): RpcLog => ({ topics: ['0x01'], data: '0x', blockNumber: block, transactionHash: tx as `0x${string}` });
const inRange = (all: RpcLog[]) => (f: bigint, t: bigint) => all.filter((l) => l.blockNumber! >= f && l.blockNumber! <= t);
const blockscoutDown = async () => resp('<html>Just a moment', 403);

describe('checkChain (contracts via RPC)', () => {
  it('counts distinct tx hashes among logs inside the window; uniqueSenders is null', async () => {
    const all = [log(99n, '0xa0'), log(100n, '0xa1'), log(100n, '0xa1'), log(150n, '0xa2'), log(243n, '0xa3'), log(244n, '0xa4')];
    const { c, logCalls } = client(inRange(all));
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, { client: c });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeUndefined();
    expect(r.source).toBe('chain');
    expect(r.tier).toBe('verified');
    expect(r.facts!.contracts).toEqual([{ chainId: 8453, address: TOKEN, txCount: 3, uniqueSenders: null }]);
    expect(logCalls).toEqual([[100n, 243n]]);
  });

  it('skips non-Base contracts with a note, not a failure', async () => {
    const { c } = client(() => []);
    const r = await checkChain(
      [
        { chainId: 8453, address: TOKEN },
        { chainId: 1, address: '0x' + '11'.padStart(40, '0') },
      ],
      null,
      window,
      { client: c },
    );
    expect(r.ok).toBe(true);
    expect(r.facts!.contracts).toHaveLength(1);
    expect(r.error).toContain('skipped_chain_1');
  });

  it('chunk cap sets degraded with a truncation note', async () => {
    // 12 chunks max x 50k = 600k blocks; make the window larger than that.
    const big: RpcLike = {
      async getBlock({ blockNumber }) {
        const n = blockNumber ?? 2_000_000n;
        return { number: n, timestamp: START + (n - 100n) / 10n };
      },
      async getLogs() {
        return [];
      },
    };
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, { client: big });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.error).toContain('logs_truncated');
  });

  it('RPC failure on the only target -> ok:false (never a zero-as-fact)', async () => {
    const { c } = client(() => [], { failBlocks: true });
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, { client: c });
    expect(r.ok).toBe(false);
    expect(r.facts).toBeNull();
    expect(r.error).toBe('rpc_failed: error');
  });
});

describe('checkChain (deployer via Blockscout)', () => {
  it('finds deployer creations inside the window only', async () => {
    const r = await checkChain([], DEP, window, { fetch: async () => resp(fx('deployer-transactions.json')) });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeUndefined();
    expect(r.facts!.newDeployments).toEqual([
      { address: '0x' + (0x9001).toString(16).padStart(40, '0'), txHash: '0xd1', at: '2026-11-06T02:00:00.000000Z' },
    ]);
    expect(r.facts!.holderDelta).toBeNull();
  });

  it('Blockscout 403/HTML -> newDeployments [] + degraded + blockscout_unavailable (contracts still ok)', async () => {
    const { c } = client(() => [log(120n, '0xa1')]);
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], DEP, window, { client: c, fetch: blockscoutDown });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.error).toContain('blockscout_unavailable');
    expect(r.facts!.newDeployments).toEqual([]);
    expect(r.facts!.contracts[0].txCount).toBe(1);
  });

  it('Blockscout page cap with more pages remaining -> degraded', async () => {
    const page = JSON.stringify({
      items: [{ hash: '0x1', timestamp: '2026-11-05T12:00:00.000000Z', from: { hash: DEP }, created_contract: null }],
      next_page_params: { block_number: 1, index: 0 },
    });
    let n = 0;
    const r = await checkChain([], DEP, window, { fetch: async () => (n++, resp(page)) });
    expect(n).toBe(3);
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.error).toContain('deployer_txs_truncated');
  });

  it('only Blockscout target and it fails -> ok:false', async () => {
    const r = await checkChain([], DEP, window, { fetch: blockscoutDown });
    expect(r.ok).toBe(false);
  });
});
