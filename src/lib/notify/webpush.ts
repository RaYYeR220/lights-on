import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const SUFFIX_HOSTS = ['.notify.windows.com', '.push.apple.com'];

/** Only real push services: https, default port, no credentials, exact host or an anchored suffix. Never an IP literal. */
export function isAllowedPushEndpoint(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.replace(/\.$/, '');
  if (host !== host.toLowerCase() || host.startsWith('[') || /^[0-9.]+$/.test(host)) return false;
  return EXACT_HOSTS.has(host) || SUFFIX_HOSTS.some((suf) => host.endsWith(suf) && host.length > suf.length);
}

/** Canonical form of an endpoint URL: lowercase host, no trailing dot, no default port. Null when it is not a URL. */
export function normalizeEndpoint(u: string): string | null {
  try {
    const url = new URL(u);
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.href;
  } catch {
    return null;
  }
}

/** sha256 of the normalised endpoint (falls back to the raw string for non-URLs, which never pass the schema). */
export const endpointHash = (endpoint: string): string =>
  createHash('sha256').update(normalizeEndpoint(endpoint) ?? endpoint).digest('hex');

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).transform((u) => normalizeEndpoint(u) ?? u).refine(isAllowedPushEndpoint, 'endpoint not allowed'), // validated in its stored form
  keys: z.object({
    p256dh: z.string().min(16).max(256).regex(B64URL),
    auth: z.string().min(8).max(128).regex(B64URL),
  }),
});
export type PushSub = z.infer<typeof PushSubscriptionSchema>;

export const SubscribeBody = z.object({
  subscription: PushSubscriptionSchema,
  addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(10).optional(),
  projects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(50).optional(),
});

export const parsePushTarget = (target: string): PushSub | null => {
  try {
    const v = PushSubscriptionSchema.safeParse(JSON.parse(target));
    return v.success ? v.data : null;
  } catch {
    return null;
  }
};

/** Row keyed by sha256(endpoint). */
export async function findPushRow(db: Db, endpoint: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.endpointHash, endpointHash(endpoint))).limit(1);
  return row ?? null;
}

export interface PushPayload { title: string; body: string; url: string }
export type PushResult = { ok: true } | { ok: false; gone: boolean; code: string };
export interface VapidConfig { publicKey: string; privateKey: string; subject: string }
type SendNotification = (sub: PushSub, payload: string, opts: { vapidDetails: VapidConfig; TTL: number; timeout: number }) => Promise<unknown>;

/** https site URL, else mailto:noreply@<host>. */
export function vapidSubject(siteUrl: string | undefined): string {
  const site = (siteUrl || 'https://lights-on.vercel.app').replace(/\/+$/, '');
  try {
    const u = new URL(site);
    return u.protocol === 'https:' ? `${site}/` : `mailto:noreply@${u.hostname}`;
  } catch {
    return 'mailto:noreply@lights-on.vercel.app';
  }
}

export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const privateKey = env.VAPID_PRIVATE_KEY;
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) return null;
  return { publicKey, privateKey, subject: vapidSubject(env.NEXT_PUBLIC_SITE_URL) };
}

/** Title "Lights On · night <date>", body = first two lines of the briefing, url = where a click goes. */
export function pushPayload(briefing: string, date: string, address?: string): PushPayload {
  const lines = briefing.split('\n').filter((l, i) => i > 0 || !/^Lights On/.test(l));
  return {
    title: `Lights On · night ${date}`,
    body: lines.slice(0, 2).join('\n').slice(0, 300),
    url: address ? `/b/${address}` : '/night',
  };
}

/** 404/410 from the push service means the subscription is gone. */
export async function sendPush(
  sub: PushSub, payload: PushPayload, cfg: VapidConfig, send?: SendNotification,
): Promise<PushResult> {
  try {
    const fn: SendNotification = send ?? (async (s, p, o) => (await import('web-push')).default.sendNotification(s, p, o));
    await fn(sub, JSON.stringify(payload), { vapidDetails: cfg, TTL: 86_400, timeout: 10_000 });
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: unknown })?.statusCode;
    if (status === 404 || status === 410) return { ok: false, gone: true, code: `http_${status}` };
    return { ok: false, gone: false, code: typeof status === 'number' ? `http_${status}` : 'error' };
  }
}

/** Swappable for tests: the confirmation push sent when someone subscribes. */
export const pushHooks: { confirm: (sub: PushSub) => Promise<PushResult> | null } = {
  confirm: (sub) => {
    const cfg = vapidFromEnv();
    if (!cfg) return null;
    return sendPush(sub, {
      title: 'Lights On',
      body: 'Subscribed to Lights On — your briefing arrives after the 05:00 UTC shift',
      url: '/night',
    }, cfg);
  },
};

const HOUR = 3_600_000;
/**
 * In-memory limiter for confirmation pushes: 10 attempts per IP hash per hour and 300 per hour overall.
 * State is per server instance and instances are ephemeral (cold starts reset it, parallel instances each keep their
 * own), so this only bounds abuse; the durable per-IP limit is the reservation row in the database.
 */
export const attemptLimiter = {
  perIp: 10,
  global: 300,
  byIp: new Map<string, number[]>(),
  all: [] as number[],
  /** Records an attempt; false = over a limit (nothing recorded, nothing may be sent). */
  take(ipHash: string, now = Date.now()): boolean {
    this.all = this.all.filter((t) => now - t < HOUR);
    const mine = (this.byIp.get(ipHash) ?? []).filter((t) => now - t < HOUR);
    if (mine.length >= this.perIp || this.all.length >= this.global) { this.byIp.set(ipHash, mine); return false; }
    mine.push(now);
    this.all.push(now);
    this.byIp.set(ipHash, mine);
    if (this.byIp.size > 5000) for (const [k, v] of this.byIp) if (v.every((t) => now - t >= HOUR)) this.byIp.delete(k);
    return true;
  },
  reset() { this.byIp.clear(); this.all = []; },
};
