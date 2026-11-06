import { getDb } from '@/lib/db';
import { getEvidence } from '@/lib/db/queries';
import { json } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { canonicalize } from '@/lib/shift/evidence';
import { canonicalRedirect } from '@/lib/api';
import { cachedRead } from '@/lib/apiCache';
import { ToolError } from '@/lib/mcp/errors';

export const runtime = 'nodejs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The stored evidence bundle, byte for byte as it was hashed: the body is canonical JSON, so
 * keccak256(body) equals the hash in the URL. Content-addressed, so it never changes.
 */
export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }): Promise<Response> {
  const hash = (await ctx.params).hash ?? '';
  if (!HASH.test(hash)) return json({ error: 'invalid_hash' }, 400);
  const redirect = canonicalRedirect(req, []); // takes no query: `?x=` must not bypass the CDN
  if (redirect) return redirect;
  try {
    const key = hash.toLowerCase();
    const bundle = await cachedRead(`evidence:${key}`, req.headers, async () => {
      const b = await getEvidence(await getDb(), key);
      if (!b) throw new ToolError('not_found', 404); // never cached: the bundle may be written a moment later
      return b;
    }).catch((e) => {
      if (e instanceof ToolError && e.code === 'not_found') return null;
      throw e;
    });
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
    if (e instanceof ToolError) {
      return json({ error: e.code }, e.status, e.retryAfterSec ? { 'retry-after': String(e.retryAfterSec) } : {});
    }
    console.error('evidence route failed:', safeErrorCode(e));
    return json({ error: 'internal' }, 500);
  }
}
