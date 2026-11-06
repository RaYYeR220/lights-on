import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

export class BlockedUrl extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrl';
  }
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family?: number }[]>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  lookup?: LookupFn;
  /** TEST ONLY: skip the address blocklist (lets integration tests hit a local server). Never set in prod code. */
  allowPrivateForTests?: boolean;
  /** Test seam; defaults to undici's fetch (same package as the pinned Agent). */
  fetch?: FetchFn;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  headers: Headers;
  body: string;
  truncated: boolean;
  latencyMs: number;
}

const MAX_HOPS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function userAgent(): string {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://lights-on.vercel.app').replace(/\/+$/, '');
  return `LightsOnWatcher/1.0 (+${site}/methodology)`;
}

/** Allowlist: only globally routable unicast passes. Unwraps IPv4-mapped; checks embedded v4 of 6to4/Teredo/NAT64. */
export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (!isIP(host)) return true;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(host);
  } catch {
    return true;
  }
  const range = addr.range();
  if (range === 'unicast') {
    if (addr.kind() === 'ipv6') {
      const b = (addr as ipaddr.IPv6).toByteArray();
      // ::/96 IPv4-compatible (ipaddr.js calls these unicast): block entirely
      if (b.slice(0, 12).every((x) => x === 0)) return true;
      // 64:ff9b:1::/48 local-use NAT64
      if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return true;
    }
    return false;
  }
  if (addr.kind() === 'ipv6') {
    const b = (addr as ipaddr.IPv6).toByteArray();
    const v4 = (i: number, xor = 0) => b.slice(i, i + 4).map((x) => x ^ xor).join('.');
    if (range === '6to4') return isBlockedAddress(v4(2));
    if (range === 'teredo') return isBlockedAddress(v4(4)) || isBlockedAddress(v4(12, 0xff));
    if (range === 'rfc6052') return isBlockedAddress(v4(12));
  }
  return true;
}

const defaultLookup: LookupFn = (h) => dnsLookup(h, { all: true });

/**
 * Connect-time lookup for the undici Agent: resolves all addresses, refuses if ANY is blocked,
 * and hands back only vetted addresses, so the socket connects to exactly what was checked
 * (Host/SNI stay the original hostname).
 */
export function guardedLookup(lookup: LookupFn = defaultLookup, allowPrivate = false) {
  return (
    hostname: string,
    opts: { all?: boolean } | undefined,
    cb: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    lookup(hostname).then(
      (answers) => {
        if (!answers.length) return cb(new Error(`dns: no addresses for ${hostname}`));
        for (const a of answers) {
          if (!allowPrivate && isBlockedAddress(a.address)) return cb(new BlockedUrl(`host ${hostname} resolves to blocked address ${a.address}`));
        }
        const list = answers.map((a) => ({ address: a.address, family: a.family ?? (isIP(a.address) || 4) }));
        if (opts?.all) cb(null, list);
        else cb(null, list[0].address, list[0].family);
      },
      (e) => cb(e as Error),
    );
  };
}

async function assertSafe(u: URL, lookup: LookupFn, allowPrivate = false): Promise<void> {
  const blocked = (a: string) => !allowPrivate && isBlockedAddress(a);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrl(`scheme not allowed: ${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrl('credentials in URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedUrl('empty host');
  if (isIP(host)) {
    if (blocked(host)) throw new BlockedUrl(`address blocked: ${host}`);
    return;
  }
  let answers: { address: string }[];
  try {
    answers = await lookup(host);
  } catch (e) {
    throw new Error(`dns lookup failed for ${host}: ${(e as Error).message}`);
  }
  if (!answers.length) throw new Error(`dns: no addresses for ${host}`);
  for (const a of answers) {
    if (blocked(a.address)) throw new BlockedUrl(`host ${host} resolves to blocked address ${a.address}`);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<SafeFetchResult> {
  const lookup = init.lookup ?? defaultLookup;
  const agent = new Agent({ connect: { lookup: guardedLookup(lookup, init.allowPrivateForTests) as never } });
  const rawFetch: FetchFn = init.fetch ?? ((u, i) => undiciFetch(u, i as never) as unknown as Promise<Response>);
  const doFetch: FetchFn = (u, i) => rawFetch(u, { ...i, dispatcher: agent } as RequestInit);
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new BlockedUrl('invalid URL');
    }
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      await assertSafe(current, lookup, init.allowPrivateForTests);
      const res = await doFetch(current.toString(), {
        method: init.method ?? 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': userAgent(), accept: 'text/html,application/json;q=0.9,*/*;q=0.5', ...init.headers },
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        try {
          current = new URL(loc, current);
        } catch {
          throw new BlockedUrl('invalid redirect location');
        }
        continue;
      }
      const { body, truncated } = await readCapped(res, maxBytes);
      return {
        status: res.status,
        finalUrl: current.toString(),
        headers: res.headers,
        body,
        truncated,
        latencyMs: Date.now() - started,
      };
    }
    throw new Error(`too many redirects (>${MAX_HOPS})`);
  } finally {
    clearTimeout(timer);
    void agent.close().catch(() => {});
  }
}
