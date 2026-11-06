import { vi } from 'vitest';
import type { Hex } from 'viem';
import type { Db } from '@/lib/db';
import { upsertProject } from '@/lib/db/queries';
import type { NewProject, ProjectRow } from '@/lib/db/schema';
import type { Adapters, ShiftDeps } from '@/lib/shift/deps';
import type { LiveAppFacts, RepoFacts } from '@/lib/types';
import type { NightAttestation } from '@/lib/attest/eas';

export const NOW = new Date('2026-11-06T05:12:00.000Z');
export const TX = `0x${'ab'.repeat(32)}` as Hex;
export const uidOf = (i: number) => `0x${i.toString(16).padStart(64, '0')}` as Hex;

export const repoFacts = (o: Partial<RepoFacts> = {}): RepoFacts => ({
  host: 'github', repo: 'o/r', branch: 'main', headSha: 'head2', mode: 'atom',
  commits: [{
    sha: 'c1', author: 'dev', authorIsBot: false, date: '2026-11-05T12:00:00Z', message: 'feat: x',
    files: null, additions: null, deletions: null, kind: 'code',
  }],
  releases: [],
  ...o,
});

export const liveFacts = (o: Partial<LiveAppFacts> = {}): LiveAppFacts => ({
  url: 'https://app.example', finalUrl: 'https://app.example/', httpStatus: 200, up: true, latencyMs: 42,
  deployFingerprint: 'fp2', textHash: 'th2', title: 'App', bytes: 5000, newDeploy: false,
  textDelta: { added: ['New pricing.'], removed: [], changedChars: 2048 },
  ...o,
});

export function stubAdapters(over: Partial<Adapters> = {}): Adapters {
  return {
    repo: vi.fn(async () => ({ result: { source: 'repo', tier: 'verified', ok: true, facts: repoFacts() }, etag: 'etag2' })),
    liveapp: vi.fn(async () => ({
      result: { source: 'liveapp', tier: 'verified', ok: true, facts: liveFacts() },
      text: 'Hello. New pricing.',
    })),
    chain: vi.fn(async () => ({
      source: 'chain', tier: 'verified', ok: true,
      facts: { contracts: [{ chainId: 8453, address: '0xc0', txCount: 3, uniqueSenders: null }], newDeployments: [], holderDelta: null },
    })),
    vibestarter: vi.fn(async (campaignId: string) => ({
      source: 'vibestarter', tier: 'verified', ok: true,
      facts: { campaignId, raiseStatus: 'FUNDED', tranches: [], openWindow: null, founderUpdates: [], reportedActivity: [] },
    })),
    ...over,
  } as unknown as Adapters;
}

/** Test deps: pglite db, stub adapters/attest/explain, a settable clock, network disabled. */
export function makeDeps(db: Db, over: Partial<ShiftDeps> = {}) {
  const clock = { now: new Date(NOW) };
  let n = 0;
  const attestMany = vi.fn(async (ns: NightAttestation[]) => ({ uids: ns.map(() => uidOf(++n)), txHash: TX }));
  const attest = vi.fn(async () => ({ uid: uidOf(10_000 + ++n), txHash: TX }));
  const deps: ShiftDeps = {
    db,
    fetch: async () => { throw new Error('network disabled in tests'); },
    now: () => new Date(clock.now),
    budget: async () => true,
    attest: attest as unknown as ShiftDeps['attest'],
    attestMany: attestMany as unknown as ShiftDeps['attestMany'],
    explain: vi.fn(async () => ({ aiOk: true, summary: 'Code changes landed.', notable: [], aiSubstance: null, model: 'm', tokens: 10 })),
    adapters: stubAdapters(),
    agentId: 42n,
    ...over,
  };
  return { deps, clock };
}

export function seedProject(db: Db, slug: string, extra: Partial<NewProject> = {}): Promise<ProjectRow> {
  return upsertProject(db, {
    slug, name: slug, source: 'community',
    liveUrl: `https://${slug}.example`, repoHost: 'github', repo: `o/${slug}`,
    contracts: [{ chainId: 8453, address: '0xc0', role: 'app' }, { chainId: 8453, address: '0xd0', role: 'deployer' }],
    vibestarter: { campaignId: 'camp1', escrow: '0xe0', founderWallet: '0xf0' },
    createdAt: new Date('2026-11-01T00:00:00Z'),
    ...extra,
  });
}

/** Resolves once `cond()` is true (polls the microtask/event loop). */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
