import { z } from 'zod';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { claimLimiter, resolveClaimDeps, verifyClaimerSession } from '@/lib/claim';
import { failure, limiterKey, tooMany } from '@/lib/claimHttp';
import { dailyBudget, draftUpdate } from '@/lib/draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Text only; posting the update on-chain (needs an IPFS pin) is out of scope. Needs a fresh SIWE session of the claimer. */
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
    const { slug, message, signature } = body;
    const deps = await resolveClaimDeps();
    const s = await verifyClaimerSession({ slug, message, signature, purpose: 'draft' }, deps);
    if (!s.ok) return failure(s.reason);
    const now = deps.now ?? (() => new Date());
    const out = await draftUpdate(slug, {
      db: deps.db, now,
      ai: process.env.VENICE_API_KEY ? { budget: dailyBudget(deps.db, now) } : undefined,
    });
    return json({ text: out.text, aiOk: out.aiOk });
  } catch (e) {
    console.error('claim.draft failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
