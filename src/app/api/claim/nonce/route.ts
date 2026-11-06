import { z } from 'zod';
import { getAddress } from 'viem';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { getProjectBySlug } from '@/lib/db/queries';
import { buildSiweMessage, issueClaimNonce, nonceLimiter, resolveClaimDeps } from '@/lib/claim';
import { limiterKey, tooMany } from '@/lib/claimHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z.string().min(1).max(100),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
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
    const nonce = await issueClaimNonce(body.slug, deps, purpose);
    const message = body.address
      ? buildSiweMessage({ address: getAddress(body.address), nonce, project, purpose, night: body.night }, deps)
      : null;
    return json({ nonce, message });
  } catch (e) {
    console.error('claim.nonce failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
