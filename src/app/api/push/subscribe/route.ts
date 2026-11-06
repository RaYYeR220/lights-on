import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getProjectBySlug } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { clientIp, hashIp } from '@/lib/shift/limits';
import { utcDay } from '@/lib/shift/night';
import { endpointHash, findPushRow, pushHooks, PushSubscriptionSchema, SubscribeBody } from '@/lib/notify/webpush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PUSH_ROWS = 5000;
const NEW_PER_IP_PER_HOUR = 5;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.INTERNAL_RUN_TOKEN;
  if (!secret) return json({ error: 'misconfigured' }, 503); // the requester-hash salt
  let body: z.infer<typeof SubscribeBody>;
  try {
    body = SubscribeBody.parse(await req.json());
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  try {
    const db = await getDb();
    const ids: number[] = [];
    for (const slug of new Set(body.projects ?? [])) {
      const p = await getProjectBySlug(db, slug);
      if (p && !p.hidden) ids.push(p.id);
    }
    const addresses = [...new Set((body.addresses ?? []).map((a) => a.toLowerCase()))];
    if (ids.length === 0 && addresses.length === 0) return json({ error: 'nothing_to_follow' }, 400);

    const { endpoint, keys } = body.subscription;
    const target = JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    const hash = endpointHash(endpoint);
    const existing = await findPushRow(db, endpoint);
    if (existing) {
      await db.update(subscriptions).set({ target, addresses, projectIds: ids }).where(eq(subscriptions.id, existing.id));
    } else {
      const [{ n: total }] = await db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.channel, 'webpush'));
      if (Number(total) >= MAX_PUSH_ROWS) return json({ error: 'subscriptions_full' }, 503);
      const ipHash = hashIp(clientIp(req.headers), 'push-subscribe', secret);
      const [{ n: recent }] = await db.select({ n: count() }).from(subscriptions)
        .where(and(eq(subscriptions.ipHash, ipHash), gt(subscriptions.createdAt, new Date(Date.now() - 3_600_000))));
      if (Number(recent) >= NEW_PER_IP_PER_HOUR) return json({ error: 'rate_limited' }, 429, { 'retry-after': '3600' });
      // Prove the endpoint is real before it takes a slot: the push service must accept a confirmation push.
      const confirm = pushHooks.confirm({ endpoint, keys });
      if (!confirm) return json({ error: 'push_not_configured' }, 503);
      const proof = await confirm;
      if (!proof.ok) return json({ error: 'endpoint_rejected' }, 400);
      await db.insert(subscriptions)
        .values({ channel: 'webpush', target, addresses, projectIds: ids, endpointHash: hash, ipHash })
        .onConflictDoUpdate({ target: subscriptions.endpointHash, set: { target, addresses, projectIds: ids } });
    }
    return json({ ok: true, projects: ids.length, addresses: addresses.length });
  } catch (e) {
    console.error('push.subscribe failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  let endpoint: string;
  try {
    endpoint = z.object({ endpoint: PushSubscriptionSchema.shape.endpoint }).parse(await req.json()).endpoint;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  try {
    const db = await getDb();
    await db.delete(subscriptions).where(or(
      eq(subscriptions.endpointHash, endpointHash(endpoint)),
      and(isNull(subscriptions.endpointHash), sql`${subscriptions.target}::jsonb->>'endpoint' = ${endpoint}`),
    ));
    return json({ ok: true });
  } catch (e) {
    console.error('push.unsubscribe failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
