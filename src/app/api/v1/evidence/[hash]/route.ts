import { getDb } from '@/lib/db';
import { getEvidence } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { canonicalize } from '@/lib/shift/evidence';

export const runtime = 'nodejs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The stored evidence bundle, byte for byte as it was hashed: the body is canonical JSON, so
 * keccak256(body) equals the hash in the URL. Content-addressed, so it never changes.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }): Promise<Response> {
  const hash = (await ctx.params).hash ?? '';
  if (!HASH.test(hash)) return json({ error: 'invalid_hash' }, 400);
  try {
    const bundle = await getEvidence(await getDb(), hash.toLowerCase());
    if (!bundle) return json({ error: 'not_found' }, 404, { 'cache-control': 'public, max-age=60' });
    return new Response(canonicalize(bundle), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    console.error('evidence route failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
