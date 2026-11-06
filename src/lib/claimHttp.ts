import { json } from '@/lib/net/http';
import { clientIp, hashIp } from '@/lib/shift/limits';
import type { ClaimReason } from '@/lib/claim';

const STATUS: Record<ClaimReason, number> = {
  bad_request: 400, unknown_project: 404, bad_message: 400, wrong_chain: 400, wrong_domain: 400, wrong_uri: 400,
  wrong_statement: 400, expired: 400, bad_nonce: 400, bad_signature: 401, proof_missing: 422, claimed_by_other: 409,
  not_claimer: 403, bad_night: 400, no_such_night: 404, too_long: 400, empty_note: 400, banned_word: 400, internal: 500,
};

export const failure = (reason: ClaimReason): Response => json({ error: reason }, STATUS[reason] ?? 500);

/** Stable requester key (fixed salt label, so it holds across the whole limiter window). */
export function limiterKey(h: Headers): string {
  return hashIp(clientIp(h), 'claim', process.env.INTERNAL_RUN_TOKEN || 'lights-on-claim');
}

export const tooMany = (): Response => json({ error: 'rate_limited' }, 429, { 'retry-after': '600' });
