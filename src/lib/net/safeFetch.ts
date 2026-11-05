import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
  /** Test seam; defaults to global fetch. */
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

function v4ToInts(a: string): number[] | null {
  const p = a.split('.');
  if (p.length !== 4) return null;
  const n = p.map(Number);
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? n : null;
}

function isBlockedV4(a: string): boolean {
  const n = v4ToInts(a);
  if (!n) return true; // unparsable: fail closed
  const [a0, a1] = n;
  return (
    a0 === 0 ||
    a0 === 10 ||
    a0 === 127 ||
    (a0 === 100 && a1 >= 64 && a1 <= 127) ||
    (a0 === 169 && a1 === 254) ||
    (a0 === 172 && a1 >= 16 && a1 <= 31) ||
    (a0 === 192 && a1 === 168) ||
    a0 >= 224 // multicast + reserved + broadcast
  );
}

/** Expand an IPv6 literal to 8 16-bit groups, or null. */
function parseV6(addr: string): number[] | null {
  let a = addr.split('%')[0].toLowerCase();
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = v4ToInts(m[2]);
    if (!v4) return null;
    a = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function v4FromGroups(g: number[]): string {
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '');
  const fam = isIP(host);
  if (fam === 4) return isBlockedV4(host);
  if (fam !== 6) return true;
  const g = parseV6(host);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedV4(v4FromGroups(g));
  }
  // NAT64 64:ff9b::/96 embeds a v4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(v4FromGroups(g));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const defaultLookup: LookupFn = (h) => dnsLookup(h, { all: true });

async function assertSafe(u: URL, lookup: LookupFn): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrl(`scheme not allowed: ${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrl('credentials in URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedUrl('empty host');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrl(`address blocked: ${host}`);
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
    if (isBlockedAddress(a.address)) throw new BlockedUrl(`host ${host} resolves to blocked address ${a.address}`);
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
  const doFetch: FetchFn = init.fetch ?? ((u, i) => fetch(u, i));
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
      await assertSafe(current, lookup);
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
  }
}
