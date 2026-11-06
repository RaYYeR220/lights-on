import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getProjectBySlug } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { clientIp, hashIp } from '@/lib/shift/limits';
import { utcDay } from '@/lib/shift/night';
import { attemptLimiter, endpointHash, findPushRow, pushHooks, PushSubscriptionSchema, SubscribeBody } from '@/lib/notify/webpush';

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
    if (existing?.pending) return json({ error: 'in_progress' }, 409);
    if (existing) {
      await db.update(subscriptions).set({ target, addresses, projectIds: ids }).where(eq(subscriptions.id, existing.id));
    } else {
      const [{ n: total }] = await db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.channel, 'webpush'));
      if (Number(total) >= MAX_PUSH_ROWS) return json({ error: 'subscriptions_full' }, 503);
      const ipHash = hashIp(clientIp(req.headers), 'push-subscribe', secret);
      // Every confirmation attempt counts, successful or not (per instance; see attemptLimiter).
      if (!attemptLimiter.take(ipHash)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '3600' });
      // Reservations whose request died never confirm; clear them so they stop counting.
      await db.delete(subscriptions).where(and(eq(subscriptions.pending, true), lt(subscriptions.createdAt, new Date(Date.now() - 600_000))));
      // Atomic reservation: the per-IP count and the insert are one statement, so concurrent requests cannot all pass.
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const res = await db.execute(sql`
        INSERT INTO subscriptions (channel, target, addresses, project_ids, endpoint_hash, ip_hash, pending)
        SELECT 'webpush', ${target}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(addresses)}::jsonb)),
               ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::int), ${hash}, ${ipHash}, true
        WHERE (SELECT count(*) FROM subscriptions WHERE ip_hash = ${ipHash} AND created_at > ${since}::timestamptz) < ${NEW_PER_IP_PER_HOUR}
        ON CONFLICT (endpoint_hash) DO NOTHING
        RETURNING id`);
      const reserved = (res as unknown as { rows: { id: number }[] }).rows[0];
      if (!reserved) {
        return (await findPushRow(db, endpoint))
          ? json({ error: 'in_progress' }, 409)
          : json({ error: 'rate_limited' }, 429, { 'retry-after': '3600' });
      }
      // Prove the endpoint is real: the push service must accept a confirmation push.
      let ok = false;
      try {
        const confirm = pushHooks.confirm({ endpoint, keys });
        if (!confirm) {
          await db.delete(subscriptions).where(eq(subscriptions.id, reserved.id));
          return json({ error: 'push_not_configured' }, 503);
        }
        ok = (await confirm).ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        await db.delete(subscriptions).where(eq(subscriptions.id, reserved.id));
        return json({ error: 'endpoint_rejected' }, 400);
      }
      await db.update(subscriptions).set({ pending: false }).where(eq(subscriptions.id, reserved.id));
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
