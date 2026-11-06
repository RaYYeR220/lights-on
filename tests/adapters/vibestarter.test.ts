import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkVibestarter, listVibestarterCampaigns } from '@/lib/adapters/vibestarter';
import type { SafeFetchResult } from '@/lib/net/safeFetch';

const fx = (d: string, n: string) => readFileSync(path.join(__dirname, '..', 'fixtures', d, n), 'utf8');
const resp = (body: string, status = 200): SafeFetchResult => ({
  status,
  finalUrl: 'x',
  headers: new Headers(),
  body,
  truncated: false,
  latencyMs: 1,
});
const CORVO = 'cmtgv5sv60012pazi968hujgc';
const CORVO_ESCROW = '0xa6f5e2a0547de81a7761567d87c226d36733c4b6';
const VS = 'cmq8qxb9q0004y5z2ua09y581';
const VS_ESCROW = '0x0e9bf34baed84a80d7647dafe4db52169147c911';
const window = { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' };

function router(activity: string | Error = '{"activities":[],"total":0}') {
  return async (u: string): Promise<SafeFetchResult> => {
    if (u.includes('/api/campaigns')) return resp(fx('vibestarter', 'campaigns.json'));
    if (u.includes('/api/mcp/activity')) {
      if (activity instanceof Error) throw activity;
      return resp(activity);
    }
    if (u.includes('/logs')) return resp(fx('blockscout', 'escrow-logs.json'));
    throw new Error('unexpected ' + u);
  };
}

describe('checkVibestarter', () => {
  it('Corvo: 7 tranches, kickstart PAID, no open window, empty activity', async () => {
    const r = await checkVibestarter(CORVO, CORVO_ESCROW, window, { fetch: router() });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('verified');
    const f = r.facts!;
    expect(f.raiseStatus).toBe('FUNDED');
    expect(f.tranches).toHaveLength(7);
    expect(f.tranches[0]).toMatchObject({ index: 0, status: 'PAID' });
    expect(f.openWindow).toBeNull();
    expect(f.reportedActivity).toEqual([]);
  });

  it('only FounderUpdate logs inside the window are kept', async () => {
    const r = await checkVibestarter(CORVO, CORVO_ESCROW, window, { fetch: router() });
    expect(r.facts!.founderUpdates).toEqual([{ cid: 'bafyIN', at: '2026-11-05T12:00:00.000Z' }]);
  });

  it('challengeWindowEndsAt in the future -> openWindow set', async () => {
    const r = await checkVibestarter(VS, VS_ESCROW, window, { fetch: router() });
    expect(r.facts!.openWindow).toMatchObject({
      index: 4,
      status: 'REQUESTED',
      windowEndsAt: '2026-11-06T16:52:57.000Z',
    });
  });

  it('`now` dep moves the open-window reference', async () => {
    const r = await checkVibestarter(VS, VS_ESCROW, window, { fetch: router(), now: '2026-11-07T00:00:00.000Z' });
    expect(r.facts!.openWindow).toBeNull();
  });

  it('activity failure keeps result ok with reportedActivity []', async () => {
    const r = await checkVibestarter(CORVO, CORVO_ESCROW, window, { fetch: router(new Error('down')) });
    expect(r.ok).toBe(true);
    expect(r.facts!.reportedActivity).toEqual([]);
  });

  it('maps activity defensively, skips unknown shapes, filters to window', async () => {
    const act = JSON.stringify({
      activities: [
        { type: 'commit', message: 'pushed fix', createdAt: '2026-11-05T10:00:00Z' },
        { kind: 'deploy', summary: 'deployed', timestamp: '2026-11-05T11:00:00Z' },
        { type: 'old', summary: 'too old', at: '2026-10-01T00:00:00Z' },
        { weird: true },
        'nope',
      ],
      total: 5,
    });
    const r = await checkVibestarter(CORVO, CORVO_ESCROW, window, { fetch: router(act) });
    expect(r.facts!.reportedActivity).toEqual([
      { type: 'commit', summary: 'pushed fix', at: '2026-11-05T10:00:00.000Z' },
      { type: 'deploy', summary: 'deployed', at: '2026-11-05T11:00:00.000Z' },
    ]);
  });

  it('unknown campaign -> ok:false, never throws', async () => {
    const r = await checkVibestarter('nope', CORVO_ESCROW, window, { fetch: router() });
    expect(r.ok).toBe(false);
  });

  it('campaigns call failing -> ok:false', async () => {
    const r = await checkVibestarter(CORVO, CORVO_ESCROW, window, {
      fetch: async () => {
        throw new Error('net');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/net/);
  });
});

describe('listVibestarterCampaigns', () => {
  it('lists campaigns with escrow, founder wallet, token', async () => {
    const l = await listVibestarterCampaigns({ fetch: router() });
    expect(l).toHaveLength(5);
    const c = l.find((x) => x.id === CORVO)!;
    expect(c).toMatchObject({ title: 'Corvo Edge', escrow: CORVO_ESCROW, status: 'FUNDED' });
    expect(c.founderWallet).toMatch(/^0x/);
    expect(c.token).toMatch(/^0x/);
  });
});
