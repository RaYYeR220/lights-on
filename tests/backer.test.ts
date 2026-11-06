import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'viem';
import { makeTestDb } from './helpers/db';
import { seedProject } from './helpers/shift';
import { discoverBacker, resolveBackerProjectIds, resetBackerCache, loadVibestarterIndex, setBackerDepsForTests } from '@/lib/backer';
import { GET } from '@/app/api/v1/briefing/[address]/route';

vi.setConfig({ testTimeout: 30_000 });

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures/vibestarter', n), 'utf8');
const BACKINGS = fx('backings-recent.json');
const CAMPAIGNS = fx('campaigns.json');
const CORVO_CUID = 'cmtgv5sv60012pazi968hujgc';
const CORVO_LAUNCH = '0x0a0e57b94010c414c41a5e28673c3cedc82a9031d4d0e0b6e53361fe5c5c3995';
const TOP = '0x60bc5323c0e0e9144af0b35ce8de119fc743e345'; // two Corvo Edge backings: 0.01 + 0.01 ETH
const TOKEN = '0xce58d80d32ce44769bdcfcbf1227599ed126ee79';

const ok = (body: string) => ({ status: 200, finalUrl: '', headers: new Headers(), body, truncated: false, latencyMs: 1 });
function fakeFetch(opts: { fail?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (opts.fail) throw Object.assign(new Error('boom https://secret'), { name: 'TimeoutError' });
    if (url.includes('/api/backings/recent')) return ok(BACKINGS);
    if (url.includes('/api/campaigns')) return ok(CAMPAIGNS);
    throw new Error('unexpected ' + url);
  });
}
/** multicall stub: contracts alternate balanceOf, decimals. */
function fakeClient(balances: Record<string, bigint>, decimals = 18) {
  return {
    multicall: vi.fn(async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((c) => c.functionName === 'balanceOf'
        ? { status: 'success' as const, result: balances[c.address.toLowerCase()] ?? 0n }
        : { status: 'success' as const, result: decimals })),
  };
}

beforeEach(() => { resetBackerCache(); setBackerDepsForTests(null); });

async function setup() {
  const db = await makeTestDb();
  const corvo = await seedProject(db, 'corvo-edge', {
    name: 'Corvo Edge', vibestarter: { campaignId: CORVO_CUID, escrow: '0x' + '11'.repeat(20), founderWallet: '0x' + '22'.repeat(20) }, token: { chainId: 8453, address: TOKEN, symbol: 'CORVO' },
  });
  return { db, corvo };
}

describe('loadVibestarterIndex', () => {
  it('maps campaign launchTxHash to the campaign cuid and sums per wallet', async () => {
    const idx = await loadVibestarterIndex({ fetch: fakeFetch() });
    expect(idx.launchToCuid.get(CORVO_LAUNCH)).toBe(CORVO_CUID);
    const mine = idx.byWallet.get(TOP)!.find((b) => b.campaignId === CORVO_LAUNCH)!;
    expect(mine.amountWei).toBe('20000000000000000');
    expect(mine.campaignTitle).toBe('Corvo Edge');
  });
  it('caches for 10 minutes', async () => {
    const f = fakeFetch();
    await loadVibestarterIndex({ fetch: f, now: () => 1000 });
    const n = f.mock.calls.length;
    await loadVibestarterIndex({ fetch: f, now: () => 1000 + 9 * 60_000 });
    expect(f.mock.calls.length).toBe(n);
    await loadVibestarterIndex({ fetch: f, now: () => 1000 + 11 * 60_000 });
    expect(f.mock.calls.length).toBeGreaterThan(n);
  });
});

describe('discoverBacker', () => {
  it('contributor -> via vibestarter with summed amount (mapped through launch tx hash)', async () => {
    const { db } = await setup();
    const r = await discoverBacker(getAddress(TOP), { db, fetch: fakeFetch(), client: fakeClient({}) });
    expect(r.degraded).toBe(false);
    expect(r.projects).toEqual([expect.objectContaining({ slug: 'corvo-edge', via: 'vibestarter', amountWei: '20000000000000000' })]);
  });
  it('falls back to campaign title when the project has no campaignId', async () => {
    const db = await makeTestDb();
    await seedProject(db, 'corvo-edge', { name: 'corvo EDGE', vibestarter: null });
    const r = await discoverBacker(TOP, { db, fetch: fakeFetch(), client: fakeClient({}) });
    expect(r.projects.map((p) => p.slug)).toEqual(['corvo-edge']);
  });
  it('holder with non-zero balance -> via token; zero balances excluded', async () => {
    const { db } = await setup();
    const other = '0x' + '99'.repeat(20);
    const none = await discoverBacker(other, { db, fetch: fakeFetch(), client: fakeClient({}) });
    expect(none.projects).toEqual([]);
    const held = await discoverBacker(other, { db, fetch: fakeFetch(), client: fakeClient({ [TOKEN]: 1_500_000_000_000_000_000n }) });
    expect(held.projects).toEqual([expect.objectContaining({ slug: 'corvo-edge', via: 'token', balance: '1.5', symbol: 'CORVO' })]);
  });
  it('vibestarter failure -> tokens only + degraded', async () => {
    const { db } = await setup();
    const r = await discoverBacker(TOP, { db, fetch: fakeFetch({ fail: true }), client: fakeClient({ [TOKEN]: 5n * 10n ** 18n }) });
    expect(r.degraded).toBe(true);
    expect(r.projects).toEqual([expect.objectContaining({ slug: 'corvo-edge', via: 'token', balance: '5' })]);
  });
  it('resolveBackerProjectIds unions ids and skips invalid addresses', async () => {
    const { db, corvo } = await setup();
    const ids = await resolveBackerProjectIds([TOP, 'nope'], { db, fetch: fakeFetch(), client: fakeClient({}) });
    expect(ids).toEqual([corvo.id]);
  });
});

describe('GET /api/v1/briefing/[address]', () => {
  const call = (a: string) => GET(new Request('http://x/api/v1/briefing/' + a), { params: Promise.resolve({ address: a }) });
  it('invalid address -> 400', async () => {
    const r = await call('0x123');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_address');
  });
  it('ENS without ETH_RPC_URL -> 400 ens_unavailable', async () => {
    vi.stubEnv('ETH_RPC_URL', '');
    const r = await call('vitalik.eth');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('ens_unavailable');
    vi.unstubAllEnvs();
  });
  it('returns projects + template briefing, cacheable', async () => {
    const { db } = await setup();
    setBackerDepsForTests({ db, fetch: fakeFetch(), client: fakeClient({}) });
    const r = await call(TOP);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, s-maxage=300');
    const j = await r.json();
    expect(j.address).toBe(getAddress(TOP));
    expect(j.projects[0]).toMatchObject({ slug: 'corvo-edge', name: 'Corvo Edge', via: 'vibestarter' });
    expect(j.projects[0].id).toBeUndefined();
    expect(j.briefing.aiOk).toBe(false);
    expect(j.briefing.text).toContain('Corvo Edge');
  });
  it('degraded flag when vibestarter fails', async () => {
    const { db } = await setup();
    setBackerDepsForTests({ db, fetch: fakeFetch({ fail: true }), client: fakeClient({}) });
    const j = await (await call(TOP)).json();
    expect(j.degraded).toBe(true);
    expect(j.projects).toEqual([]);
  });
});
