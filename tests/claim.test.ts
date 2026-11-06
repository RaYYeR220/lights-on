import { describe, it, expect, beforeEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { claimNonces, founderNotes, projects } from '@/lib/db/schema';
import { insertNight } from '@/lib/db/queries';
import {
  addFounderNote, buildSiweMessage, issueClaimNonce, nonceLimiter, claimLimiter, setClaimDepsForTests, verifyClaim,
  verifyClaimerSession, type ClaimDeps,
} from '@/lib/claim';
import { renderBadge, renderNotWatched } from '@/lib/badge';
import { draftUpdate } from '@/lib/draft';
import { makeTestDb } from './helpers/db';
import { seedProject } from './helpers/shift';
import { POST as noncePOST } from '@/app/api/claim/nonce/route';
import { POST as claimPOST } from '@/app/api/claim/route';
import { POST as draftPOST } from '@/app/api/claim/draft/route';
import { POST as notesPOST } from '@/app/api/notes/route';
import { GET as badgeGET } from '@/app/badge/[slug]/route';

vi.setConfig({ testTimeout: 30_000 });

const SITE = 'https://lights-on.test';
const NOW = new Date('2026-11-06T09:00:00.000Z');
const founder = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);

let db: Db;
let clock: Date;
const ok = (body: string, status = 200) => ({ status, finalUrl: '', headers: new Headers(), body, truncated: false, latencyMs: 1 });
let wellKnown: (url: string) => ReturnType<NonNullable<ClaimDeps['safeFetch']>>;

const deps = (): Partial<ClaimDeps> => ({ db, now: () => clock, siteUrl: SITE, safeFetch: (u) => wellKnown(u) });

async function project(over: Record<string, unknown> = {}) {
  return seedProject(db, 'corvo', { name: 'Corvo Edge', liveUrl: 'https://corvo.example', ...over } as never);
}
async function sign(acct: typeof founder, slug: string, purpose: 'claim' | 'note' | 'draft', night?: number, nonceIn?: string) {
  const nonce = nonceIn ?? (await issueClaimNonce(slug, deps(), purpose, acct.address));
  const message = buildSiweMessage({ address: acct.address, nonce, project: { slug, name: 'Corvo Edge' }, purpose, night }, deps());
  return { nonce, message, signature: await acct.signMessage({ message }) };
}

beforeEach(async () => {
  db = await makeTestDb();
  clock = new Date(NOW);
  wellKnown = async () => ok('', 404);
  nonceLimiter.reset();
  claimLimiter.reset();
  setClaimDepsForTests(deps());
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
});

describe('verifyClaim', () => {
  it('method 1: signer equals the Vibestarter founder wallet', async () => {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address.toLowerCase() } });
    const s = await sign(founder, 'corvo', 'claim');
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: true, method: 'vibestarter_founder' });
    const [p] = await db.select().from(projects).where(eq(projects.slug, 'corvo'));
    expect(p.claimedBy).toBe(founder.address.toLowerCase());
    expect(p.claimVerifiedAt).not.toBeNull();
  });

  it('method 2: well-known file carries the nonce', async () => {
    await project();
    const s = await sign(other, 'corvo', 'claim');
    wellKnown = async (u) => { expect(u).toBe('https://corvo.example/.well-known/lights-on.txt'); return ok(`hello\nlights-on-claim=${other.address.toLowerCase()}:${s.nonce}\n`); };
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: true, method: 'well_known' });
  });

  it('well-known nonce mismatch is rejected and nothing is claimed', async () => {
    await project();
    const s = await sign(other, 'corvo', 'claim');
    wellKnown = async () => ok(`lights-on-claim=${other.address.toLowerCase()}:deadbeefdeadbeefdeadbeef\n`);
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: false, reason: 'proof_missing' });
    const [p] = await db.select().from(projects).where(eq(projects.slug, 'corvo'));
    expect(p.claimedBy).toBeNull();
  });

  it('SIWE with the wrong chain id is rejected', async () => {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    const nonce = await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    const message = createSiweMessage({
      address: founder.address, chainId: 1, domain: 'lights-on.test', nonce, uri: SITE, version: '1',
      statement: 'Claim Corvo Edge on Lights On', issuedAt: NOW, expirationTime: new Date(NOW.getTime() + 600_000),
    });
    const signature = await founder.signMessage({ message });
    expect(await verifyClaim({ slug: 'corvo', message, signature }, deps())).toEqual({ ok: false, reason: 'wrong_chain' });
  });

  it('rejects a wrong domain, a wrong statement and a bad signature', async () => {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    const mk = async (o: { domain?: string; statement?: string }) => {
      const nonce = await issueClaimNonce('corvo', deps(), 'claim', founder.address);
      const message = createSiweMessage({
        address: founder.address, chainId: 8453, domain: o.domain ?? 'lights-on.test', nonce, uri: SITE, version: '1',
        statement: o.statement ?? 'Claim Corvo Edge on Lights On', issuedAt: NOW, expirationTime: new Date(NOW.getTime() + 600_000),
      });
      return { message, signature: await founder.signMessage({ message }) };
    };
    const a = await mk({ domain: 'evil.example' });
    expect(await verifyClaim({ slug: 'corvo', ...a }, deps())).toEqual({ ok: false, reason: 'wrong_domain' });
    const b = await mk({ statement: 'Claim something else' });
    expect(await verifyClaim({ slug: 'corvo', ...b }, deps())).toEqual({ ok: false, reason: 'wrong_statement' });
    const c = await mk({});
    const forged = await other.signMessage({ message: c.message });
    expect(await verifyClaim({ slug: 'corvo', message: c.message, signature: forged }, deps())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('nonces are single use and expire after 10 minutes', async () => {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    const s = await sign(founder, 'corvo', 'claim');
    expect((await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).ok).toBe(true);
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: false, reason: 'bad_nonce' });
    const t = await sign(founder, 'corvo', 'claim');
    clock = new Date(NOW.getTime() + 11 * 60_000);
    expect(await verifyClaim({ slug: 'corvo', message: t.message, signature: t.signature }, deps())).toEqual({ ok: false, reason: 'expired' });
  });

  it('a claim nonce cannot be spent on a note (purpose bound)', async () => {
    await project();
    const n = await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    const s = await sign(founder, 'corvo', 'note', 20261105, n);
    expect(await addFounderNote({ slug: 'corvo', night: 20261105, note: 'x', ...s }, deps())).toEqual({ ok: false, reason: 'bad_nonce' });
  });

  it('re-claim: another wallet cannot take over via well-known; the founder wallet can (method 1)', async () => {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    await db.update(projects).set({ claimedBy: other.address.toLowerCase(), claimVerifiedAt: NOW }).where(eq(projects.slug, 'corvo'));
    const third = privateKeyToAccount(`0x${'33'.repeat(32)}`);
    const t = await sign(third, 'corvo', 'claim');
    wellKnown = async () => ok(`lights-on-claim=${third.address.toLowerCase()}:${t.nonce}`);
    expect(await verifyClaim({ slug: 'corvo', message: t.message, signature: t.signature }, deps())).toEqual({ ok: false, reason: 'claimed_by_other' });
    const f = await sign(founder, 'corvo', 'claim');
    expect(await verifyClaim({ slug: 'corvo', message: f.message, signature: f.signature }, deps())).toEqual({ ok: true, method: 'vibestarter_founder' });
    const [p] = await db.select().from(projects).where(eq(projects.slug, 'corvo'));
    expect(p.claimedBy).toBe(founder.address.toLowerCase());
  });
});

describe('address-bound nonces and conditional ownership', () => {
  const third = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  const line = (a: { address: string }, n: string) => `lights-on-claim=${a.address.toLowerCase()}:${n}`;

  it('an attacker signing a nonce issued to another address gets bad_nonce', async () => {
    await project();
    const nonce = await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    const s = await sign(other, 'corvo', 'claim', undefined, nonce);
    wellKnown = async () => ok(line(other, nonce));
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: false, reason: 'bad_nonce' });
  });

  it('a proof line naming another address (or none) is rejected', async () => {
    await project();
    const s = await sign(other, 'corvo', 'claim');
    wellKnown = async () => ok(line(founder, s.nonce));
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: false, reason: 'proof_missing' });
    wellKnown = async () => ok(`lights-on-claim=${s.nonce}`);
    expect(await verifyClaim({ slug: 'corvo', message: s.message, signature: s.signature }, deps())).toEqual({ ok: false, reason: 'proof_missing' });
  });

  it('a concurrent second claimer gets claimed_by_other', async () => {
    await project();
    const a = await sign(other, 'corvo', 'claim');
    const b = await sign(third, 'corvo', 'claim');
    wellKnown = async () => ok(`${line(other, a.nonce)}\n${line(third, b.nonce)}\n`);
    const [ra, rb] = await Promise.all([
      verifyClaim({ slug: 'corvo', message: a.message, signature: a.signature }, deps()),
      verifyClaim({ slug: 'corvo', message: b.message, signature: b.signature }, deps()),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect([ra, rb].find((r) => !r.ok)).toMatchObject({ ok: false });
  });

  it('a malformed address is bad_message, not a 500', async () => {
    await project();
    const nonce = await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    const message = buildSiweMessage({ address: founder.address, nonce, project: { slug: 'corvo', name: 'Corvo Edge' }, purpose: 'claim' }, deps())
      .replace(founder.address, '0xnotanaddress');
    expect(await verifyClaim({ slug: 'corvo', message, signature: '0x1234' }, deps())).toMatchObject({ ok: false });
  });

  it('expired nonce rows are purged on the next issue', async () => {
    await project();
    await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    clock = new Date(NOW.getTime() + 3 * 3_600_000);
    await issueClaimNonce('corvo', deps(), 'claim', founder.address);
    expect(await db.select().from(claimNonces)).toHaveLength(1);
  });
});

describe('founder notes', () => {
  async function claimed() {
    await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    const [p] = await db.select().from(projects).where(eq(projects.slug, 'corvo'));
    await db.update(projects).set({ claimedBy: founder.address.toLowerCase(), claimVerifiedAt: NOW }).where(eq(projects.id, p.id));
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'quiet', observed: true });
    return p;
  }

  it('stores a sanitized note by the verified claimer and keeps the signature', async () => {
    const p = await claimed();
    const s = await sign(founder, 'corvo', 'note', 20261105);
    const r = await addFounderNote({ slug: 'corvo', night: 20261105, note: 'We were <b>shipping</b> to https://x.example [docs](https://y.example)', message: s.message, signature: s.signature }, deps());
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(founderNotes).where(eq(founderNotes.projectId, p.id));
    expect(row.note).toBe('We were shipping to docs');
    expect(row.signature).toBe(s.signature);
    expect(row.author).toBe(founder.address.toLowerCase());
    expect(row.night).toBe('2026-11-05');
  });

  it('banned words cannot hide behind markup', async () => {
    await claimed();
    for (const note of ['this is a sc<b>am</b>', 'ru[x](y)g pull', 'fr*a*ud']) {
      const s = await sign(founder, 'corvo', 'note', 20261105);
      expect(await addFounderNote({ slug: 'corvo', night: 20261105, note, ...s }, deps())).toEqual({ ok: false, reason: 'banned_word' });
    }
  });

  it('rejects over-long notes and banned words', async () => {
    await claimed();
    const s = await sign(founder, 'corvo', 'note', 20261105);
    expect(await addFounderNote({ slug: 'corvo', night: 20261105, note: 'a'.repeat(281), ...s }, deps())).toEqual({ ok: false, reason: 'too_long' });
    expect(await addFounderNote({ slug: 'corvo', night: 20261105, note: 'this is not a scam', ...s }, deps())).toEqual({ ok: false, reason: 'banned_word' });
  });

  it('a note by a non-claimer is not_claimer', async () => {
    await claimed();
    const s = await sign(other, 'corvo', 'note', 20261105);
    expect(await addFounderNote({ slug: 'corvo', night: 20261105, note: 'hi', ...s }, deps())).toEqual({ ok: false, reason: 'not_claimer' });
  });

  it('the signed night must match the note night', async () => {
    await claimed();
    const s = await sign(founder, 'corvo', 'note', 20261104);
    expect(await addFounderNote({ slug: 'corvo', night: 20261105, note: 'hi', ...s }, deps())).toEqual({ ok: false, reason: 'wrong_statement' });
  });
});

describe('routes', () => {
  const post = (url: string, body: unknown, ip = '1.2.3.4') =>
    new Request(`${SITE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(body) });

  it('nonce -> claim -> note, with fixed error codes and a 403 for a non-claimer', async () => {
    process.env.INTERNAL_RUN_TOKEN = 'test-secret';
    const p = await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'quiet', observed: true });

    const n1 = await (await noncePOST(post('/api/claim/nonce', { slug: 'corvo', address: founder.address }))).json();
    expect(n1.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(n1.message).toContain('Claim Corvo Edge on Lights On');
    const sig1 = await founder.signMessage({ message: n1.message });
    const c = await claimPOST(post('/api/claim', { slug: 'corvo', message: n1.message, signature: sig1 }));
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ ok: true, method: 'vibestarter_founder' });

    const mkNote = async (acct: typeof founder) => {
      const n = await (await noncePOST(post('/api/claim/nonce', { slug: 'corvo', address: acct.address, purpose: 'note', night: 20261105 }))).json();
      return { message: n.message as string, signature: await acct.signMessage({ message: n.message }) };
    };
    const good = await notesPOST(post('/api/notes', { slug: 'corvo', night: 20261105, note: 'Mainnet launch was held for audit.', ...(await mkNote(founder)) }));
    expect(good.status).toBe(200);
    const bad = await notesPOST(post('/api/notes', { slug: 'corvo', night: 20261105, note: 'hello', ...(await mkNote(other)) }));
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: 'not_claimer' });
    const junk = await notesPOST(post('/api/notes', { nope: 1 }));
    expect(junk.status).toBe(400);
  });

  it('nonce route is rate limited to 10 per 10 minutes per IP and 404s unknown slugs', async () => {
    process.env.INTERNAL_RUN_TOKEN = 'test-secret';
    await project();
    for (let i = 0; i < 10; i++) expect((await noncePOST(post('/api/claim/nonce', { slug: 'corvo', address: founder.address }))).status).toBe(200);
    expect((await noncePOST(post('/api/claim/nonce', { slug: 'corvo', address: founder.address }))).status).toBe(429);
    expect((await noncePOST(post('/api/claim/nonce', { slug: 'nope', address: founder.address }, '9.9.9.9'))).status).toBe(404);
  });

  it('draft route requires the claimer session', async () => {
    process.env.INTERNAL_RUN_TOKEN = 'test-secret';
    const p = await project({ vibestarter: { campaignId: 'c', escrow: '0x0', founderWallet: founder.address } });
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'shipped', observed: true, summary: 'Added the withdraw flow.' });
    await db.update(projects).set({ claimedBy: founder.address.toLowerCase(), claimVerifiedAt: NOW }).where(eq(projects.id, p.id));
    const q = (s: { message: string; signature: string }) => post('/api/claim/draft', { slug: 'corvo', message: s.message, signature: s.signature }, '5.5.5.5');
    const okRes = await draftPOST(q(await sign(founder, 'corvo', 'draft')));
    expect(okRes.status).toBe(200);
    const body = await okRes.json();
    expect(body.text).toContain('[2026-11-05]');
    expect(body.aiOk).toBe(false);
    const denied = await draftPOST(q(await sign(other, 'corvo', 'draft')));
    expect(denied.status).toBe(403);
  });

  it('verifyClaimerSession refuses an unclaimed project', async () => {
    await project();
    const s = await sign(founder, 'corvo', 'draft');
    expect(await verifyClaimerSession({ slug: 'corvo', purpose: 'draft', ...s }, deps())).toEqual({ ok: false, reason: 'not_claimer' });
  });
});

describe('badge', () => {
  it('renders the SVG (snapshot)', () => {
    expect(renderBadge({ streak: 4, lit30: 22, lastShip: 20261103 }, 'shipped')).toMatchInlineSnapshot(`"<svg xmlns="http://www.w3.org/2000/svg" width="177" height="24" viewBox="0 0 177 24" role="img" aria-label="lights on · lit 22/30"><title>lights on · lit 22/30</title><rect width="177" height="24" rx="12" fill="#14181c"/><circle cx="14" cy="12" r="4.5" fill="#f2efe6"/><text x="26" y="16" fill="#f2efe6" font-family='ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' font-size="11" font-weight="600">lights on · lit 22/30</text></svg>"`);
  });

  it('uses only two colours and a ring dot when not lit', () => {
    const svg = renderBadge({ streak: 0, lit30: 3, lastShip: null }, 'quiet');
    expect([...new Set(svg.match(/#[0-9a-f]{6}/g))].sort()).toEqual(['#14181c', '#f2efe6']);
    expect(svg).toContain('fill="none"');
    expect(svg).not.toMatch(/Clash/i);
    expect(renderNotWatched()).toContain('not watched');
  });

  it('route: 200 + cache header for a watched slug, a neutral badge for an unknown one', async () => {
    const p = await project();
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'shipped', observed: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const r = await badgeGET(new Request(`${SITE}/badge/corvo`), { params: Promise.resolve({ slug: 'corvo' }) });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('image/svg+xml');
      expect(r.headers.get('cache-control')).toBe('public, max-age=600');
      expect(await r.text()).toContain('lit 1/30');
      const u = await badgeGET(new Request(`${SITE}/badge/zzz`), { params: Promise.resolve({ slug: 'zzz' }) });
      expect(u.status).toBe(200);
      expect(u.headers.get('cache-control')).toBe('public, max-age=600');
      expect(await u.text()).toContain('not watched');
    } finally { vi.useRealTimers(); }
  });
});

describe('draftUpdate', () => {
  async function seedNights() {
    const p = await project();
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'shipped', observed: true, summary: 'Added the withdraw flow.' });
    await insertNight(db, { projectId: p.id, night: '2026-11-03', status: 'building', observed: true, summary: 'Refactored the vault <b>module</b> https://x.example' });
    await insertNight(db, { projectId: p.id, night: '2026-11-02', status: 'quiet', observed: true, summary: 'Nothing visible.' });
    await insertNight(db, { projectId: p.id, night: '2026-10-20', status: 'shipped', observed: false, summary: 'Early prototype commits.' });
    await insertNight(db, { projectId: p.id, night: '2026-09-01', status: 'shipped', observed: true, summary: 'Too old.' });
    return p;
  }

  it('template lists shipped/building nights, cites dates, labels reconstructed ones', async () => {
    await seedNights();
    const r = await draftUpdate('corvo', { db, now: () => NOW });
    expect(r.aiOk).toBe(false);
    expect(r.text).toContain('[2026-11-05] shipped: Added the withdraw flow.');
    expect(r.text).toContain('[2026-11-03] building: Refactored the vault module');
    expect(r.text).toContain('[2026-10-20] shipped (reconstructed from git history): Early prototype commits.');
    expect(r.text).not.toContain('Too old');
    expect(r.text).not.toContain('Nothing visible');
    expect(r.text).not.toMatch(/https?:/);
  });

  it('AI rephrase is used when it keeps names, numbers and dates; dropped when it invents or drops a date', async () => {
    await seedNights();
    const tpl = (await draftUpdate('corvo', { db, now: () => NOW })).text;
    const good = tpl.replace('Update from', 'Update, from');
    const mk = (content: string) => (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 90 } }) }));
    const budget = vi.fn(async () => true);
    const r1 = await draftUpdate('corvo', { db, now: () => NOW, ai: { budget, apiKey: 'k', fetchImpl: mk(good) } });
    expect(r1).toEqual({ text: good, aiOk: true });
    const r2 = await draftUpdate('corvo', { db, now: () => NOW, ai: { budget, apiKey: 'k', fetchImpl: mk(tpl.replace('[2026-11-05]', '[2026-11-09]')) } });
    expect(r2).toEqual({ text: tpl, aiOk: false });
    const r3 = await draftUpdate('corvo', { db, now: () => NOW, ai: { budget, apiKey: 'k', fetchImpl: mk(tpl.replace('[2026-11-05] ', '')) } });
    expect(r3.aiOk).toBe(false);
    const r4 = await draftUpdate('corvo', { db, now: () => NOW, ai: { budget: async () => false, apiKey: 'k', fetchImpl: mk(good) } });
    expect(r4).toEqual({ text: tpl, aiOk: false });
  });

  it('with no evidence the draft says so plainly', async () => {
    await project();
    const r = await draftUpdate('corvo', { db, now: () => NOW });
    expect(r.text).toContain('No shipped or building nights');
  });
});
