import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine((u) => {
    try { return new URL(u).protocol === 'https:'; } catch { return false; }
  }, 'endpoint must be https'),
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

/** Row keyed by endpoint (the target holds the whole subscription as JSON). */
export async function findPushRow(db: Db, endpoint: string) {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.channel, 'webpush'));
  return rows.find((r) => parsePushTarget(r.target)?.endpoint === endpoint) ?? null;
}

export interface PushPayload { title: string; body: string; url: string }
export type PushResult = { ok: true } | { ok: false; gone: boolean; code: string };
export interface VapidConfig { publicKey: string; privateKey: string; subject: string }
type SendNotification = (sub: PushSub, payload: string, opts: { vapidDetails: VapidConfig; TTL: number; timeout: number }) => Promise<unknown>;

export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const privateKey = env.VAPID_PRIVATE_KEY;
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) return null;
  const site = (env.NEXT_PUBLIC_SITE_URL || 'https://lights-on.vercel.app').replace(/\/+$/, '');
  return { publicKey, privateKey, subject: `${site}/` };
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
