import { describe, it, expect } from 'vitest';
import { buildSeedProjects, kebab, roleFromLabel, type SeedFile } from '@/lib/backfill/seed';
import type { CampaignListing } from '@/lib/adapters/vibestarter';

const seed: SeedFile = {
  vibeathon01: [
    { name: 'Corvo Edge', live_url: 'https://old', repo: null, contracts: [
      { chainId: 8453, address: '0xt', label: '$CORVO token (Vibestarter launch)' },
      { chainId: 8453, address: '0xf', label: 'founder wallet (EOA, per Vibestarter API)' },
    ] },
    { name: 'Grayl AI', live_url: 'https://x', repo: { name: 'a/v3', default_branch: 'main' }, serving_repo: { name: 'a/v3.1', default_branch: 'main' }, contracts: [] },
  ],
  base: [{ name: 'Tradewise (HackAgent)', live_url: null, repo_host: 'github', repo: 'o/r', default_branch: 'master', contracts: [] },
    { name: 'tradewise hackagent', live_url: null, repo: null, contracts: [] }],
};
const camp = (o: Partial<CampaignListing>): CampaignListing =>
  ({ id: 'c1', title: 'Corvo Edge', tagline: 't', escrow: '0xe', founderWallet: '0xf', token: '0xt', status: 'FUNDED', chainId: 8453, ...o });

describe('seed', () => {
  it('kebab + roles', () => {
    expect(kebab('YieldMax.AI')).toBe('yieldmax-ai');
    expect(roleFromLabel('Vibestarter tranche escrow')).toBe('escrow');
    expect(roleFromLabel('$ONE token (x)')).toBe('token');
    expect(roleFromLabel('StreamVaults (proxy)')).toBe('contract');
  });
  it('merges raises by name, uses serving repo, skips failed, drops founder wallet, dedupes slugs', () => {
    const { drafts, skippedRaises } = buildSeedProjects(seed, [camp({}), camp({ id: 'c2', title: 'Gone', status: 'FAILED' })]);
    const corvo = drafts.find((d) => d.slug === 'corvo-edge')!;
    expect(corvo.source).toBe('vibestarter');
    expect(corvo.liveUrl).toBe('https://app.corvoedge.xyz');
    expect(corvo.contracts).toEqual([{ chainId: 8453, address: '0xt', role: 'token' }, { chainId: 8453, address: '0xe', role: 'escrow' }]);
    expect(corvo.token).toEqual({ chainId: 8453, address: '0xt', symbol: 'CORVO' });
    expect(corvo.vibestarter).toEqual({ campaignId: 'c1', escrow: '0xe', founderWallet: '0xf' });
    expect(drafts.find((d) => d.slug === 'grayl-ai')!.repo).toBe('a/v3.1');
    expect(skippedRaises.map((c) => c.title)).toEqual(['Gone']);
    expect(drafts.some((d) => d.name === 'Gone')).toBe(false);
    expect(drafts.map((d) => d.slug)).toContain('tradewise-hackagent');
  });
});
