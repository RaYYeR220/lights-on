import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkChain } from '@/lib/adapters/chain';
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

describe('checkChain', () => {
  it('counts txCount and uniqueSenders only inside the window', async () => {
    const urls: string[] = [];
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, {
      fetch: async (u) => (urls.push(u), resp(fx('transactions.json'))),
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('chain');
    expect(r.tier).toBe('verified');
    expect(r.facts!.contracts).toEqual([{ chainId: 8453, address: TOKEN, txCount: 3, uniqueSenders: 2 }]);
    expect(urls[0]).toContain(`https://base.blockscout.com/api/v2/addresses/${TOKEN}/transactions`);
    expect(urls).toHaveLength(1); // oldest item is before window.start -> stop paging
  });

  it('pages until older than window, max 3 pages', async () => {
    let n = 0;
    const page = JSON.stringify({
      items: [
        {
          hash: '0x1',
          timestamp: '2026-11-05T12:00:00.000000Z',
          from: { hash: '0x' + 'aa'.padStart(40, '0') },
          created_contract: null,
        },
      ],
      next_page_params: { block_number: 1, index: 0 },
    });
    const urls: string[] = [];
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, {
      fetch: async (u) => (n++, urls.push(u), resp(page)),
    });
    expect(n).toBe(3);
    expect(urls[1]).toContain('block_number=1');
    expect(r.facts!.contracts[0].txCount).toBe(3);
  });

  it('finds deployer creations inside the window only', async () => {
    const r = await checkChain([], DEP, window, { fetch: async () => resp(fx('deployer-transactions.json')) });
    expect(r.ok).toBe(true);
    expect(r.facts!.newDeployments).toEqual([
      { address: '0x' + (0x9001).toString(16).padStart(40, '0'), txHash: '0xd1', at: '2026-11-06T02:00:00.000000Z' },
    ]);
    expect(r.facts!.holderDelta).toBeNull();
  });

  it('never throws: all calls failing -> ok:false', async () => {
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, {
      fetch: async () => {
        throw new Error('boom');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
  });

  it('non-JSON (challenge page) is an error, not a crash', async () => {
    const r = await checkChain([{ chainId: 8453, address: TOKEN }], null, window, {
      fetch: async () => resp('<html>Just a moment', 403),
    });
    expect(r.ok).toBe(false);
  });
});
