import { z } from 'zod';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { claimLimiter, verifyClaim } from '@/lib/claim';
import { failure, limiterKey, tooMany } from '@/lib/claimHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ slug: z.string().min(1).max(100), message: z.string().max(2000), signature: z.string().max(2002) });

export async function POST(req: Request): Promise<Response> {
  try {
    if (!claimLimiter.take(limiterKey(req.headers))) return tooMany();
    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(await req.json());
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const r = await verifyClaim(body);
    return r.ok ? json({ ok: true, method: r.method }) : failure(r.reason);
  } catch (e) {
    console.error('claim failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
