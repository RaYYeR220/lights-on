import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getProjectBySlug } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { findPushRow, PushSubscriptionSchema, SubscribeBody } from '@/lib/notify/webpush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
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
    const { endpoint, keys } = body.subscription;
    const target = JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    const existing = await findPushRow(db, endpoint);
    if (existing) {
      await db.update(subscriptions).set({ target, addresses, projectIds: ids }).where(eq(subscriptions.id, existing.id));
    } else {
      await db.insert(subscriptions).values({ channel: 'webpush', target, addresses, projectIds: ids });
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
    const row = await findPushRow(db, endpoint);
    if (row) await db.delete(subscriptions).where(eq(subscriptions.id, row.id));
    return json({ ok: true });
  } catch (e) {
    console.error('push.unsubscribe failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
