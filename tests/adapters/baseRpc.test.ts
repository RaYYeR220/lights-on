import { describe, it, expect } from 'vitest';
import { blockAtTime, getLogsChunked, windowBlocks, type RpcLike, type RpcLog } from '@/lib/adapters/baseRpc';

/** Fake chain with a known schedule: block n has timestamp ts(n). */
function fakeClient(latest: bigint, ts: (n: bigint) => bigint, logs: (from: bigint, to: bigint) => RpcLog[] = () => []) {
  const state = { blockCalls: 0, logCalls: [] as [bigint, bigint][] };
  const client: RpcLike = {
    async getBlock({ blockNumber }) {
      state.blockCalls++;
      const n = blockNumber ?? latest;
      return { number: n, timestamp: ts(n) };
    },
    async getLogs({ fromBlock, toBlock }) {
      state.logCalls.push([fromBlock, toBlock]);
      return logs(fromBlock, toBlock);
    },
  };
  return { client, state };
}

describe('blockAtTime', () => {
  it('finds the first block with timestamp >= t on a 1 block/s schedule', async () => {
    const { client, state } = fakeClient(40_000_000n, (n) => 1_700_000_000n + n);
    const b = await blockAtTime(client, 1_700_000_000 + 39_000_000);
    expect(b).toBe(39_000_000n);
    expect(state.blockCalls).toBeLessThanOrEqual(24);
  });

  it('handles a block-time change (2 s then 200 ms) within the call budget', async () => {
    const UP = 30_000_000n; // upgrade block
    const T0 = 1_700_000_000n;
    const ts = (n: bigint) => (n <= UP ? T0 + n * 2n : T0 + UP * 2n + (n - UP) / 5n);
    const { client, state } = fakeClient(UP + 500_000n, ts);
    const target = Number(T0 + UP * 2n - 3_600n); // one hour before the upgrade
    const b = await blockAtTime(client, target);
    expect(ts(b)).toBeGreaterThanOrEqual(BigInt(target));
    expect(ts(b - 1n)).toBeLessThan(BigInt(target));
    expect(state.blockCalls).toBeLessThanOrEqual(24);
  });

  it('returns the head when the chain has not reached the time yet', async () => {
    const { client } = fakeClient(100n, (n) => 1_000n + n);
    expect(await blockAtTime(client, 5_000)).toBe(100n);
  });

  it('windowBlocks gives an inclusive [first >= start, first >= end - 1]', async () => {
    const { client } = fakeClient(1_000n, (n) => 1_000n + n * 10n);
    const r = await windowBlocks(client, {
      start: new Date(1_100_000).toISOString(),
      end: new Date(1_200_000).toISOString(),
    });
    expect(r.fromBlock).toBe(10n);
    expect(r.toBlock).toBe(19n);
  });
});

describe('getLogsChunked', () => {
  it('splits [0, 120000] into 3 chunks', async () => {
    const { client, state } = fakeClient(0n, () => 0n, (f) => [{ topics: [], data: '0x', blockNumber: f, transactionHash: '0x01' }]);
    const r = await getLogsChunked(client, { address: '0x00000000000000000000000000000000000000aa', fromBlock: 0n, toBlock: 120_000n });
    expect(state.logCalls).toEqual([
      [0n, 49_999n],
      [50_000n, 99_999n],
      [100_000n, 120_000n],
    ]);
    expect(r.calls).toBe(3);
    expect(r.logs).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('respects the chunk cap and flags truncated', async () => {
    const { client, state } = fakeClient(0n, () => 0n);
    const r = await getLogsChunked(client, {
      address: '0x00000000000000000000000000000000000000aa',
      fromBlock: 0n,
      toBlock: 10_000_000n,
      maxChunks: 12,
    });
    expect(state.logCalls).toHaveLength(12);
    expect(r.truncated).toBe(true);
  });

  it('exactly filling the cap is not truncation', async () => {
    const { client } = fakeClient(0n, () => 0n);
    const r = await getLogsChunked(client, {
      address: '0x00000000000000000000000000000000000000aa',
      fromBlock: 0n,
      toBlock: 99_999n,
      maxChunks: 2,
    });
    expect(r.truncated).toBe(false);
  });
});
