import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { claimLimiter, resolveClaimDeps, verifyClaimerSession } from '@/lib/claim';
import { failure, limiterKey, tooMany } from '@/lib/claimHttp';
import { dailyBudget, draftUpdate } from '@/lib/draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Text only; posting the update on-chain (needs an IPFS pin) is out of scope. Needs a fresh SIWE session of the claimer. */
export async function GET(req: Request): Promise<Response> {
  try {
    if (!claimLimiter.take(limiterKey(req.headers))) return tooMany();
    const q = new URL(req.url).searchParams;
    const slug = q.get('slug') ?? '';
    const message = q.get('message') ?? '';
    const signature = q.get('signature') ?? '';
    if (!slug || !message || !signature) return json({ error: 'bad_request' }, 400);
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
