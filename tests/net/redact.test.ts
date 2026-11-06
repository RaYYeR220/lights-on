import { describe, it, expect } from 'vitest';
import { safeErrorCode, redactUrls } from '@/lib/net/redact';
import { BlockedUrl } from '@/lib/net/safeFetch';
import { checkChain } from '@/lib/adapters/chain';
import { checkVibestarter } from '@/lib/adapters/vibestarter';
import { checkLiveApp } from '@/lib/adapters/liveapp';
import { checkRepo } from '@/lib/adapters/repo';
import type { RpcLike } from '@/lib/adapters/baseRpc';

const SECRET_MSG = 'HTTP request failed. URL: https://rpc.example/v2/SECRETKEY?apikey=SECRETKEY';
const leaky = () => new Error(SECRET_MSG);
const window = { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' };
const clean = (s: string | undefined) => {
  expect(s ?? '').not.toContain('SECRETKEY');
  expect(s ?? '').not.toContain('https://');
  expect(s ?? '').not.toContain('rpc.example');
};

describe('safeErrorCode', () => {
  it('maps names, statuses and rpc codes to fixed codes and never echoes the message', () => {
    expect(safeErrorCode(leaky())).toBe('error');
    expect(safeErrorCode(new BlockedUrl('10.0.0.1 blocked'))).toBe('blocked_url');
    expect(safeErrorCode(Object.assign(new Error(SECRET_MSG), { name: 'TimeoutError' }))).toBe('timeout');
    expect(safeErrorCode(Object.assign(new Error(SECRET_MSG), { name: 'AbortError' }))).toBe('timeout');
    expect(safeErrorCode(Object.assign(new Error(SECRET_MSG), { status: 403 }))).toBe('http_403');
    expect(safeErrorCode(Object.assign(new Error(SECRET_MSG), { code: -32602 }))).toBe('rpc_error_-32602');
    expect(safeErrorCode(new Error('http_502'))).toBe('http_502');
    expect(safeErrorCode(new Error('invalid_json'))).toBe('invalid_json');
    expect(safeErrorCode('weird string ' + SECRET_MSG)).toBe('error');
    expect(safeErrorCode(null)).toBe('error');
  });
  it('looks through the cause chain (viem wraps)', () => {
    const inner = Object.assign(new Error('x'), { status: 429 });
    expect(safeErrorCode(Object.assign(new Error(SECRET_MSG), { cause: inner }))).toBe('http_429');
  });
});

describe('redactUrls', () => {
  it('replaces urls and strips key-like params', () => {
    expect(redactUrls('see https://rpc.example/v2/KEY?x=1 now')).toBe('see <url> now');
    expect(redactUrls('http://a.b/c and https://d.e')).toBe('<url> and <url>');
    expect(redactUrls('q?apikey=abc&z=1')).toBe('q?&z=1');
    expect(redactUrls('token=abc123 rest')).toBe(' rest');
    expect(redactUrls('plain text')).toBe('plain text');
  });
});

const throwing = async () => {
  throw leaky();
};
const badRpc: RpcLike = { getBlock: throwing, getLogs: throwing };

describe('adapters never leak exception messages', () => {
  it('chain (RPC + Blockscout)', async () => {
    const r = await checkChain([{ chainId: 8453, address: '0x' + 'aa'.padStart(40, '0') }], '0x' + 'de'.padStart(40, '0'), window, {
      client: badRpc,
      fetch: throwing,
    });
    clean(r.error);
    expect(r.error).toContain('rpc_failed');
  });
  it('vibestarter (REST failure and RPC failure)', async () => {
    const r1 = await checkVibestarter('c', '0x' + 'aa'.padStart(40, '0'), window, { fetch: throwing, client: badRpc });
    clean(r1.error);
    expect(r1.error).toBe('campaigns_unavailable: error');
    const campaigns = JSON.stringify({ campaigns: [{ id: 'c', status: 'FUNDED', tranches: [] }] });
    const r2 = await checkVibestarter('c', '0x' + 'aa'.padStart(40, '0'), window, {
      fetch: async (u) => {
        if (u.includes('/api/campaigns')) return { status: 200, finalUrl: u, headers: new Headers(), body: campaigns, truncated: false, latencyMs: 1 };
        throw leaky();
      },
      client: badRpc,
    });
    expect(r2.ok).toBe(true);
    clean(r2.error);
    expect(r2.error).toContain('rpc_unavailable: error');
  });
  it('liveapp', async () => {
    const r = await checkLiveApp('https://app.example.test/', null, { fetch: throwing, retryDelayMs: 0 });
    clean(r.error);
    expect(r.error).toBe('error');
  });
  it('repo (github and gitlab)', async () => {
    for (const host of ['github', 'gitlab'] as const) {
      const r = await checkRepo({ host, repo: 'a/b', branch: 'main' }, window, null, { fetch: throwing });
      clean(r.error);
    }
  });
});
