import type { NewProject, ContractRef, TokenRef } from '@/lib/db/schema';
import type { CampaignListing } from '@/lib/adapters/vibestarter';

type SeedContract = { chainId: number; address: string; label: string };
interface SeedRepoObj { host?: string; name: string; default_branch?: string }
export interface SeedFinalist {
  name: string;
  live_url: string | null;
  repo: SeedRepoObj | null;
  serving_repo?: SeedRepoObj;
  contracts: SeedContract[];
  notes?: string;
}
export interface SeedBase {
  name: string;
  description?: string;
  category?: string;
  live_url: string | null;
  repo_host?: string | null;
  repo?: string | null;
  default_branch?: string | null;
  contracts: SeedContract[];
}
export interface SeedFile { vibeathon01: SeedFinalist[]; base: SeedBase[] }

/** Raises that get a project: funded ones and ones being refunded. Failed raises were refunded and have no known live app. */
export const INCLUDED_RAISE_STATUSES = ['FUNDED', 'REFUNDING'] as const;

/** Per-project overrides from the research notes (the notes win over the listed fields). */
const OVERRIDES: Record<string, Partial<NewProject>> = {
  'Corvo Edge': { liveUrl: 'https://app.corvoedge.xyz' },
  Vibestarter: { liveUrl: 'https://app.vibestarter.xyz', repoHost: 'github', repo: 'vibesprotocol/vibestarter-contracts' },
};

export function kebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function roleFromLabel(label: string): string {
  if (/deployer/i.test(label)) return 'deployer';
  if (/escrow/i.test(label)) return 'escrow';
  if (/\btoken\b/i.test(label) || /^\$/.test(label)) return 'token';
  return 'contract';
}

/** A founder wallet is an EOA, not a contract to watch; it is kept under `vibestarter.founderWallet` instead. */
const isFounderWallet = (label: string) => /founder wallet/i.test(label);

function mapContracts(cs: SeedContract[]): ContractRef[] {
  return cs.filter((c) => !isFounderWallet(c.label)).map((c) => ({ chainId: c.chainId, address: c.address, role: roleFromLabel(c.label) }));
}

function mergeContracts(...lists: ContractRef[][]): ContractRef[] {
  const seen = new Map<string, ContractRef>();
  for (const l of lists) for (const c of l) seen.set(`${c.chainId}:${c.address.toLowerCase()}`, c);
  return [...seen.values()];
}

function tokenSymbol(cs: SeedContract[], address: string | null): string {
  const hit = cs.find((c) => address && c.address.toLowerCase() === address.toLowerCase()) ?? cs.find((c) => roleFromLabel(c.label) === 'token');
  return /\$([A-Za-z0-9]+)/.exec(hit?.label ?? '')?.[1] ?? '';
}

type Draft = Omit<NewProject, 'slug'> & { name: string };

export function buildSeedProjects(seed: SeedFile, campaigns: CampaignListing[]): { drafts: NewProject[]; skippedRaises: CampaignListing[] } {
  const byName = new Map<string, Draft>();

  for (const f of seed.vibeathon01) {
    const repo = f.serving_repo ?? f.repo;
    byName.set(norm(f.name), {
      name: f.name,
      source: 'vibeathon01',
      liveUrl: f.live_url,
      repoHost: repo ? 'github' : null,
      repo: repo?.name ?? null,
      defaultBranch: repo?.default_branch ?? null,
      contracts: mapContracts(f.contracts),
      ...OVERRIDES[f.name],
    });
  }
  for (const b of seed.base) {
    byName.set(norm(b.name), {
      name: b.name,
      tagline: b.description ?? null,
      category: b.category ?? null,
      source: 'base',
      liveUrl: b.live_url,
      repoHost: b.repo ? ((b.repo_host as 'github' | 'gitlab' | null) ?? 'github') : null,
      repo: b.repo ?? null,
      defaultBranch: b.repo ? (b.default_branch ?? 'main') : null,
      contracts: mapContracts(b.contracts),
      ...OVERRIDES[b.name],
    });
  }

  const skippedRaises: CampaignListing[] = [];
  for (const c of campaigns) {
    if (!(INCLUDED_RAISE_STATUSES as readonly string[]).includes(c.status)) {
      skippedRaises.push(c);
      continue;
    }
    const existing = byName.get(norm(c.title));
    const raiseContracts: ContractRef[] = [
      ...(c.token ? [{ chainId: c.chainId, address: c.token, role: 'token' }] : []),
      { chainId: c.chainId, address: c.escrow, role: 'escrow' },
    ];
    const seedContracts = [...(seed.vibeathon01.find((f) => norm(f.name) === norm(c.title))?.contracts ?? [])];
    const token: TokenRef | null = c.token ? { chainId: c.chainId, address: c.token, symbol: tokenSymbol(seedContracts, c.token) } : null;
    byName.set(norm(c.title), {
      ...(existing ?? { name: c.title, liveUrl: null, repoHost: null, repo: null, defaultBranch: null }),
      name: existing?.name ?? c.title,
      tagline: existing?.tagline ?? (c.tagline || null),
      source: 'vibestarter',
      contracts: mergeContracts(existing?.contracts ?? [], raiseContracts),
      token,
      vibestarter: { campaignId: c.id, escrow: c.escrow, founderWallet: c.founderWallet },
    });
  }

  const used = new Set<string>();
  const drafts: NewProject[] = [];
  for (const d of byName.values()) {
    const base = kebab(d.name);
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    drafts.push({ ...d, slug });
  }
  return { drafts, skippedRaises };
}

/**
 * Upsert patch that never blanks existing data: null / undefined / empty-array fields are dropped, so a re-seed can
 * only add or change values (an insert leaves the dropped columns at their NULL default).
 */
export function mergeDraft(d: NewProject): NewProject {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as NewProject;
}
