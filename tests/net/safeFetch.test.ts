import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { safeFetch, BlockedUrl, isBlockedAddress, guardedLookup } from '@/lib/net/safeFetch';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const mk = (body: string | Uint8Array, init: ResponseInit = {}) => async () =>
  new Response(body as BodyInit, { status: 200, ...init });

describe('safeFetch blocking', () => {
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://user:pw@example.com/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.5.5/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://224.0.0.1/',
  ])('rejects %s', async (u) => {
    const fetchImpl = vi.fn();
    await expect(safeFetch(u, { fetch: fetchImpl, lookup: pub })).rejects.toBeInstanceOf(BlockedUrl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks when ANY resolved address is private', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(safeFetch('http://evil.test/', { lookup, fetch: vi.fn() })).rejects.toBeInstanceOf(BlockedUrl);
  });

  it('blocks a redirect from public to 10.0.0.5', async () => {
    const lookup = async (h: string) =>
      h === 'internal.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://internal.test/admin' } }));
    await expect(safeFetch('http://public.test/', { lookup, fetch: fetchImpl })).rejects.toBeInstanceOf(BlockedUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect straight to a metadata IP literal', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/' } }));
    await expect(safeFetch('http://public.test/', { lookup: pub, fetch: fetchImpl })).rejects.toBeInstanceOf(BlockedUrl);
  });

  it('follows relative redirects and reports finalUrl', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0 ? new Response(null, { status: 302, headers: { location: '/app' } }) : new Response('ok'),
    );
    const r = await safeFetch('http://public.test/', { lookup: pub, fetch: fetchImpl });
    expect(r.finalUrl).toBe('http://public.test/app');
    expect(r.body).toBe('ok');
  });

  it('gives up after 5 redirect hops', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(safeFetch('http://public.test/', { lookup: pub, fetch: fetchImpl })).rejects.toThrow(/redirect/i);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('isBlockedAddress covers the ranges', () => {
    for (const a of ['127.0.0.1', '10.9.9.9', '172.31.0.1', '192.168.1.1', '169.254.1.1', '100.127.0.1', '0.1.2.3', '::1', '::', 'fe80::abcd', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '224.5.5.5', '198.18.0.1', '192.0.2.1', '192.0.0.5', '2002:7f00:1::', '2001:0:7f00:1::', '64:ff9b::7f00:1', '64:ff9b:1::1', '::7f00:1', '::a9fe:a9fe', 'garbage'])
      expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1'])
      expect(isBlockedAddress(a), a).toBe(false);
  });
});

describe('safeFetch body handling', () => {
  it('truncates at maxBytes and aborts the stream', async () => {
    const chunk = new Uint8Array(1024).fill(97);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
        if (pulled > 5000) c.close();
      },
    });
    const r = await safeFetch('http://public.test/big', {
      lookup: pub,
      fetch: async () => new Response(stream),
      maxBytes: 4096,
    });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(4096);
    expect(pulled).toBeLessThan(50);
  });

  it('defaults to a 2 MB cap and sends the watcher UA', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 500).fill(98);
    let seen: Headers | undefined;
    const r = await safeFetch('http://public.test/', {
      lookup: pub,
      fetch: async (_u, i) => {
        seen = new Headers(i?.headers);
        return new Response(big);
      },
    });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(2 * 1024 * 1024);
    expect(seen!.get('user-agent')).toMatch(/^LightsOnWatcher\/1\.0 \(\+.*\/methodology\)$/);
  });

  it('not truncated for small bodies, returns status and headers', async () => {
    const r = await safeFetch('http://public.test/', {
      lookup: pub,
      fetch: mk('{"a":1}', { status: 201, headers: { 'content-type': 'application/json' } }),
    });
    expect(r).toMatchObject({ status: 201, truncated: false, body: '{"a":1}' });
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('times out', async () => {
    const fetchImpl = (_u: string, i?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        i!.signal!.addEventListener('abort', () => rej(i!.signal!.reason ?? new Error('aborted')));
      });
    await expect(safeFetch('http://public.test/', { lookup: pub, fetch: fetchImpl, timeoutMs: 50 })).rejects.toThrow();
  });
});

describe('DNS pinning (rebinding)', () => {
  const run = (lk: Parameters<typeof guardedLookup>[0], all = true) =>
    new Promise<{ err: Error | null; res: unknown }>((resolve) =>
      guardedLookup(lk)('rebind.test', { all }, (err, res) => resolve({ err, res })),
    );

  it('first lookup public, connect-time lookup 127.0.0.1 -> refused', async () => {
    let n = 0;
    const lookup = async () => [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    const fetchImpl = vi.fn(async (_u: string, i?: RequestInit) => {
      // emulate what undici does at connect time through the Agent's lookup
      expect((i as { dispatcher?: unknown }).dispatcher).toBeDefined();
      return new Response('ok');
    });
    await safeFetch('http://rebind.test/', { lookup, fetch: fetchImpl }); // pre-check consumed the public answer
    const { err } = await run(lookup);
    expect(err).toBeInstanceOf(BlockedUrl);
  });

  it('returns only vetted addresses when all are public', async () => {
    const { err, res } = await run(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(res).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses if any answer is blocked', async () => {
    const { err } = await run(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect(err).toBeInstanceOf(BlockedUrl);
  });
});

describe('real Agent path (no fetch mock)', () => {
  async function withServer<T>(fn: (port: number, hits: () => number) => Promise<T>): Promise<T> {
    let n = 0;
    const srv = http.createServer((_q, r) => {
      n++;
      r.setHeader('content-type', 'text/html');
      r.end('<title>local</title>hello from local');
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      return await fn((srv.address() as AddressInfo).port, () => n);
    } finally {
      srv.closeAllConnections();
      await new Promise((ok) => srv.close(ok));
    }
  }

  it('rebinding: public at check time, 127.0.0.1 at connect time -> refused, server sees 0 requests', async () => {
    await withServer(async (port, hits) => {
      let calls = 0;
      const lookup = async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
      let err: unknown;
      try {
        await safeFetch(`http://lights-test.invalid:${port}/`, { lookup, timeoutMs: 3000 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      const chain = [err, (err as Error).cause, ((err as Error).cause as Error | undefined)?.cause];
      expect(chain.some((e) => e instanceof BlockedUrl || /blocked address/.test(String((e as Error)?.message)))).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(hits()).toBe(0);
    });
  });

  it('positive: request succeeds end-to-end through the pinned Agent (test-only private allow)', async () => {
    await withServer(async (port, hits) => {
      const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const r = await safeFetch(`http://lights-test.invalid:${port}/`, { lookup, allowPrivateForTests: true, timeoutMs: 3000 });
      expect(r.status).toBe(200);
      expect(r.body).toContain('hello from local');
      expect(hits()).toBe(1);
    });
  });
});
