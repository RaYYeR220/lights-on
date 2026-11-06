import { z } from 'zod';
import { getAddress } from 'viem';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { getProjectBySlug } from '@/lib/db/queries';
import { buildSiweMessage, issueClaimNonce, proofLine, nonceLimiter, resolveClaimDeps } from '@/lib/claim';
import { limiterKey, tooMany } from '@/lib/claimHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z.string().min(1).max(100),
  address: z.string().min(1).max(64),
  purpose: z.enum(['claim', 'note', 'draft']).optional(),
  night: z.number().int().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    if (!nonceLimiter.take(limiterKey(req.headers))) return tooMany();
    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(await req.json());
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const purpose = body.purpose ?? 'claim';
    if (purpose === 'note' && body.night === undefined) return json({ error: 'bad_request' }, 400);
    const deps = await resolveClaimDeps();
    const project = await getProjectBySlug(deps.db, body.slug);
    if (!project || project.hidden) return json({ error: 'unknown_project' }, 404);
    let address: string;
    try {
      address = getAddress(body.address);
    } catch {
      return json({ error: 'bad_message' }, 400);
    }
    const nonce = await issueClaimNonce(body.slug, deps, purpose, address);
    const message = buildSiweMessage({ address: address as `0x${string}`, nonce, project, purpose, night: body.night }, deps);
    return json({ nonce, message, ...(purpose === 'claim' ? { proof: proofLine(address, nonce) } : {}) });
  } catch (e) {
    console.error('claim.nonce failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
