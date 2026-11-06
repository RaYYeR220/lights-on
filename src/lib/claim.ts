import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { getAddress, isAddressEqual, verifyMessage, type Address, type Hex } from 'viem';
import { getDb, type Db } from '@/lib/db';
import { claimNonces, founderNotes, nights, projects, type ProjectRow } from '@/lib/db/schema';
import { getProjectBySlug } from '@/lib/db/queries';
import { safeFetch as realSafeFetch, type SafeFetchInit, type SafeFetchResult } from '@/lib/net/safeFetch';
import { getBaseClient } from '@/lib/adapters/baseRpc';
import { nightDate, nightNumber } from '@/lib/shift/night';
import { sanitizeSummary } from '@/lib/shift/explain';

export const CLAIM_CHAIN_ID = 8453;
export const NONCE_TTL_MS = 10 * 60_000;
export const NOTE_MAX = 280;
export const WELL_KNOWN_PATH = '/.well-known/lights-on.txt';
const WELL_KNOWN_MAX_BYTES = 4096;
const BANNED = /\b(scam|rug|dead|abandoned|fraud)\b/i;

export type Purpose = 'claim' | 'note' | 'draft';
export type ClaimMethod = 'vibestarter_founder' | 'well_known';
export type ClaimReason =
  | 'bad_request' | 'unknown_project' | 'bad_message' | 'wrong_chain' | 'wrong_domain' | 'wrong_uri'
  | 'wrong_statement' | 'expired' | 'bad_nonce' | 'bad_signature' | 'proof_missing' | 'claimed_by_other'
  | 'not_claimer' | 'bad_night' | 'no_such_night' | 'too_long' | 'empty_note' | 'banned_word' | 'internal';
export type Fail = { ok: false; reason: ClaimReason };

export interface ClaimDeps {
  db: Db;
  now?: () => Date;
  siteUrl?: string;
  safeFetch?: (url: string, init?: SafeFetchInit) => Promise<SafeFetchResult>;
  /** Signature check seam. Default: EOA recovery, then EIP-1271/6492 through the Base public client. */
  verifySig?: (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
}

let override: Partial<ClaimDeps> | null = null;
/** Test seam for the routes. */
export function setClaimDepsForTests(d: Partial<ClaimDeps> | null): void { override = d; }
export async function resolveClaimDeps(extra?: Partial<ClaimDeps>): Promise<ClaimDeps> {
  const m = { ...override, ...extra };
  return { ...m, db: m.db ?? (await getDb()) };
}

const nowOf = (d: ClaimDeps) => (d.now ?? (() => new Date()))();
const siteOf = (d: Pick<ClaimDeps, 'siteUrl'>) => d.siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lights-on.vercel.app';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The exact SIWE statement each purpose must sign. */
export function statementFor(purpose: Purpose, project: Pick<ProjectRow, 'name' | 'slug'>, night?: number): string {
  if (purpose === 'claim') return `Claim ${oneLine(project.name)} on Lights On`;
  if (purpose === 'note') return `Note on night ${night} for ${project.slug}`;
  return `Draft update for ${project.slug} on Lights On`;
}

export function buildSiweMessage(
  a: { address: Address; nonce: string; project: Pick<ProjectRow, 'name' | 'slug'>; purpose: Purpose; night?: number },
  deps: Pick<ClaimDeps, 'now' | 'siteUrl'> = {},
): string {
  const now = (deps.now ?? (() => new Date()))();
  const site = new URL(siteOf(deps));
  return createSiweMessage({
    address: a.address, chainId: CLAIM_CHAIN_ID, domain: site.host, nonce: a.nonce, uri: site.origin, version: '1',
    statement: statementFor(a.purpose, a.project, a.night), issuedAt: now,
    expirationTime: new Date(now.getTime() + NONCE_TTL_MS),
  });
}

/** Issue a single-use nonce (10 min). Throws Error('unknown_project') for an unknown slug. */
export async function issueClaimNonce(slug: string, deps: Partial<ClaimDeps> | undefined, purpose: Purpose, address: string): Promise<string> {
  const d = await resolveClaimDeps(deps);
  let addr: string;
  try {
    addr = getAddress(address).toLowerCase();
  } catch {
    throw new Error('bad_address');
  }
  const p = await getProjectBySlug(d.db, slug);
  if (!p || p.hidden) throw new Error('unknown_project');
  const now = nowOf(d);
  // Cheap housekeeping: drop nonces that expired or were spent long ago.
  await d.db.delete(claimNonces).where(or(lt(claimNonces.expiresAt, new Date(now.getTime() - 3_600_000)), lt(claimNonces.usedAt, new Date(now.getTime() - 3_600_000))));
  const nonce = randomBytes(16).toString('hex');
  await d.db.insert(claimNonces).values({
    nonceHash: sha(nonce), projectId: p.id, purpose, address: addr, expiresAt: new Date(now.getTime() + NONCE_TTL_MS),
  });
  return nonce;
}

/** The exact line the founder publishes at /.well-known/lights-on.txt (bound to the wallet that will sign). */
export function proofLine(address: string, nonce: string): string {
  return `lights-on-claim=${address.toLowerCase()}:${nonce}`;
}

async function defaultVerifySig(a: { address: Address; message: string; signature: Hex }): Promise<boolean> {
  try {
    if (await verifyMessage(a)) return true;
  } catch { /* not a plain EOA signature */ }
  try {
    // Fixed operator RPC (see baseRpc.ts); handles deployed (EIP-1271) and counterfactual (EIP-6492) smart accounts.
    const c = getBaseClient() as unknown as { verifyMessage(x: typeof a): Promise<boolean> };
    return await c.verifyMessage(a);
  } catch {
    return false;
  }
}

interface Checked { project: ProjectRow; signer: Address; nonce: string }

/** Everything about a SIWE message except consuming the nonce. */
async function checkSiwe(
  a: { slug: string; message: string; signature: string; purpose: Purpose; night?: number },
  d: ClaimDeps,
): Promise<{ ok: true; v: Checked } | Fail> {
  if (typeof a.message !== 'string' || a.message.length > 2000 || !/^0x[0-9a-fA-F]{2,1000}$/.test(String(a.signature))) {
    return { ok: false, reason: 'bad_request' };
  }
  const project = await getProjectBySlug(d.db, a.slug);
  if (!project || project.hidden) return { ok: false, reason: 'unknown_project' };
  const m = parseSiweMessage(a.message);
  if (m.address) {
    try { m.address = getAddress(m.address); } catch { return { ok: false, reason: 'bad_message' }; }
  }
  if (!m.address || !m.nonce || !m.domain || !m.uri || !m.chainId || !m.expirationTime || !m.issuedAt) {
    return { ok: false, reason: 'bad_message' };
  }
  const site = new URL(siteOf(d));
  const now = nowOf(d);
  if (m.chainId !== CLAIM_CHAIN_ID) return { ok: false, reason: 'wrong_chain' };
  if (m.domain !== site.host) return { ok: false, reason: 'wrong_domain' };
  if (m.uri !== site.origin && !m.uri.startsWith(`${site.origin}/`)) return { ok: false, reason: 'wrong_uri' };
  if (m.version !== '1') return { ok: false, reason: 'bad_message' };
  if (m.statement !== statementFor(a.purpose, project, a.night)) return { ok: false, reason: 'wrong_statement' };
  if (!validateSiweMessage({ message: m, domain: site.host, time: now })) return { ok: false, reason: 'expired' };
  if (m.issuedAt.getTime() > now.getTime() + 60_000 || now.getTime() - m.issuedAt.getTime() > NONCE_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  const [row] = await d.db.select().from(claimNonces).where(and(
    eq(claimNonces.nonceHash, sha(m.nonce)), eq(claimNonces.projectId, project.id), eq(claimNonces.purpose, a.purpose),
    eq(claimNonces.address, m.address.toLowerCase()), isNull(claimNonces.usedAt), gt(claimNonces.expiresAt, now),
  )).limit(1);
  if (!row) return { ok: false, reason: 'bad_nonce' };
  const sigOk = await (d.verifySig ?? defaultVerifySig)({ address: m.address, message: a.message, signature: a.signature as Hex });
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  return { ok: true, v: { project, signer: m.address, nonce: m.nonce } };
}

/** Atomic single use: false when another request spent (or expiry passed) in the meantime. */
async function consumeNonce(d: ClaimDeps, nonce: string, purpose: Purpose): Promise<boolean> {
  const now = nowOf(d);
  const rows = await d.db.update(claimNonces).set({ usedAt: now }).where(and(
    eq(claimNonces.nonceHash, sha(nonce)), eq(claimNonces.purpose, purpose), isNull(claimNonces.usedAt), gt(claimNonces.expiresAt, now),
  )).returning({ h: claimNonces.nonceHash });
  return rows.length > 0;
}

const isFounder = (p: ProjectRow, who: string) => {
  const w = p.vibestarter?.founderWallet;
  return !!w && /^0x[0-9a-fA-F]{40}$/.test(w) && isAddressEqual(w as Address, who as Address);
};

async function wellKnownHasNonce(p: ProjectRow, signer: string, nonce: string, d: ClaimDeps): Promise<boolean> {
  if (!p.liveUrl) return false;
  let url: string;
  try {
    url = new URL(WELL_KNOWN_PATH, p.liveUrl).toString();
  } catch {
    return false;
  }
  try {
    const r = await (d.safeFetch ?? realSafeFetch)(url, { maxBytes: WELL_KNOWN_MAX_BYTES, timeoutMs: 8000, headers: { accept: 'text/plain' } });
    if (r.status !== 200 || r.truncated) return false;
    return r.body.split(/\r?\n/).some((l) => l.trim() === proofLine(signer, nonce));
  } catch {
    return false;
  }
}

export async function verifyClaim(
  a: { slug: string; message: string; signature: string },
  deps?: Partial<ClaimDeps>,
): Promise<{ ok: true; method: ClaimMethod } | Fail> {
  try {
    const d = await resolveClaimDeps(deps);
    const c = await checkSiwe({ ...a, purpose: 'claim' }, d);
    if (!c.ok) return c;
    const { project, signer, nonce } = c.v;
    const sameClaimer = !!project.claimedBy && project.claimedBy.toLowerCase() === signer.toLowerCase();
    let method: ClaimMethod;
    if (isFounder(project, signer)) {
      method = 'vibestarter_founder';
    } else if (project.claimedBy && !sameClaimer) {
      return { ok: false, reason: 'claimed_by_other' }; // only method 1 may take over an existing claim
    } else if (await wellKnownHasNonce(project, signer, nonce, d)) {
      method = 'well_known';
    } else {
      return { ok: false, reason: 'proof_missing' };
    }
    if (!(await consumeNonce(d, nonce, 'claim'))) return { ok: false, reason: 'bad_nonce' };
    const who = signer.toLowerCase();
    const where = method === 'vibestarter_founder'
      ? eq(projects.id, project.id)
      : and(eq(projects.id, project.id), or(isNull(projects.claimedBy), eq(projects.claimedBy, who)));
    const won = await d.db.update(projects).set({ claimedBy: who, claimVerifiedAt: nowOf(d) }).where(where).returning({ id: projects.id });
    if (won.length === 0) return { ok: false, reason: 'claimed_by_other' };
    return { ok: true, method };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** A fresh SIWE session of the verified claimer (draft route): consumes the nonce. */
export async function verifyClaimerSession(
  a: { slug: string; message: string; signature: string; purpose: 'draft' },
  deps?: Partial<ClaimDeps>,
): Promise<{ ok: true; signer: string } | Fail> {
  try {
    const d = await resolveClaimDeps(deps);
    const c = await checkSiwe(a, d);
    if (!c.ok) return c;
    const p = c.v.project;
    if (!p.claimVerifiedAt || p.claimedBy?.toLowerCase() !== c.v.signer.toLowerCase()) return { ok: false, reason: 'not_claimer' };
    if (!(await consumeNonce(d, c.v.nonce, a.purpose))) return { ok: false, reason: 'bad_nonce' };
    return { ok: true, signer: c.v.signer };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** Plain text only: no HTML, markdown or URLs; banned words are rejected, not rewritten. */
export function cleanNote(raw: string): { ok: true; text: string } | Fail {
  const s = String(raw ?? '');
  if (s.length > NOTE_MAX) return { ok: false, reason: 'too_long' };
  // Banned words are checked on the raw text, on the text with markup removed outright (so "sc<b>am" and
  // "ru[x](y)g" cannot slip through) and on the sanitized result.
  const squashed = s.replace(/<[^>]*>/g, '').replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/[*_#`]/g, '');
  if (BANNED.test(s) || BANNED.test(squashed)) return { ok: false, reason: 'banned_word' };
  const t = sanitizeSummary(s);
  if (!t) return { ok: false, reason: 'empty_note' };
  if (BANNED.test(t)) return { ok: false, reason: 'banned_word' };
  return { ok: true, text: t };
}

export async function addFounderNote(
  a: { slug: string; night: number; note: string; message: string; signature: string },
  deps?: Partial<ClaimDeps>,
): Promise<{ ok: true; id: number } | Fail> {
  try {
    const d = await resolveClaimDeps(deps);
    if (!Number.isInteger(a.night) || a.night < 20200101 || a.night > 99991231) return { ok: false, reason: 'bad_night' };
    const date = nightDate(a.night);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || nightNumber(parsed) !== a.night) return { ok: false, reason: 'bad_night' };
    const note = cleanNote(a.note);
    if (!note.ok) return note;
    const c = await checkSiwe({ slug: a.slug, message: a.message, signature: a.signature, purpose: 'note', night: a.night }, d);
    if (!c.ok) return c;
    const { project, signer } = c.v;
    if (!project.claimVerifiedAt || project.claimedBy?.toLowerCase() !== signer.toLowerCase()) return { ok: false, reason: 'not_claimer' };
    const [n] = await d.db.select({ id: nights.id }).from(nights).where(and(eq(nights.projectId, project.id), eq(nights.night, date))).limit(1);
    if (!n) return { ok: false, reason: 'no_such_night' };
    if (!(await consumeNonce(d, c.v.nonce, 'note'))) return { ok: false, reason: 'bad_nonce' };
    const [row] = await d.db.insert(founderNotes).values({
      projectId: project.id, night: date, note: note.text, author: signer.toLowerCase(), signature: a.signature,
    }).returning({ id: founderNotes.id });
    return { ok: true, id: row.id };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** Per-instance sliding-window limiter keyed by an IP hash. */
export function makeLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    reset: () => hits.clear(),
    /** true = allowed. */
    take(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) { if (v.every((t) => now - t >= windowMs)) hits.delete(k); }
      return true;
    },
  };
}
export const nonceLimiter = makeLimiter(10, 10 * 60_000);
export const claimLimiter = makeLimiter(30, 10 * 60_000);
