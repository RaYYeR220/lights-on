import type { Db } from '@/lib/db';
import { bumpBudget, bumpShiftBudget, releaseBudget, type BudgetField } from '@/lib/db/queries';
import { checkLiveAppDetailed } from '@/lib/adapters/liveapp';
import { checkRepoDetailed, type FetchLike } from '@/lib/adapters/repo';
import { checkChain } from '@/lib/adapters/chain';
import { checkVibestarter } from '@/lib/adapters/vibestarter';
import { DEFAULT_BASE_RPC, getBaseClient, type RpcLike } from '@/lib/adapters/baseRpc';
import { attestMany, attestOne, type AttestDeps } from '@/lib/attest/eas';
import { getPublicClient, getWallet, type AnyPublicClient } from '@/lib/attest/signer';
import { safeFetch } from '@/lib/net/safeFetch';
import { explainNight } from './explain';
import { CAPS } from './limits';
import { utcDay } from './night';
import type { Kind } from '@/lib/types';

export interface Adapters {
  repo: typeof checkRepoDetailed;
  liveapp: typeof checkLiveAppDetailed;
  chain: typeof checkChain;
  vibestarter: typeof checkVibestarter;
}

export interface ShiftDeps {
  db: Db;
  /** Outbound fetch for adapters (prod: safeFetch). */
  fetch: FetchLike;
  now: () => Date;
  /** Pre-bound caps: true = amount reserved, false = over a cap (fail closed). */
  budget: (field: BudgetField, amount: number | bigint) => Promise<boolean>;
  /** Refund a reservation (gas before broadcast, a lost live-run race). */
  release?: (field: BudgetField, amount: number | bigint) => Promise<void>;
  attest: typeof attestOne;
  attestMany: typeof attestMany;
  explain: typeof explainNight;
  /** Task 12 hook (briefings); called once per shift, by the finalize that closes it. */
  onFinalized?: (shiftId: number) => Promise<void>;
  /** Test seams / overrides; defaults are the real adapters. */
  adapters?: Partial<Adapters>;
  /** Watcher wallet + read client; absent or wallet null -> attestation `disabled`. */
  signer?: { wallet: AttestDeps['wallet']; publicClient: AnyPublicClient };
  /** Base RPC for chain/vibestarter adapters (defaults to getBaseClient() inside them). */
  rpc?: RpcLike;
  githubToken?: string;
  agentId?: bigint;
  siteUrl?: string;
}

export function resolveAdapters(deps: ShiftDeps): Adapters {
  return {
    repo: deps.adapters?.repo ?? checkRepoDetailed,
    liveapp: deps.adapters?.liveapp ?? checkLiveAppDetailed,
    chain: deps.adapters?.chain ?? checkChain,
    vibestarter: deps.adapters?.vibestarter ?? checkVibestarter,
  };
}

export function attestDepsFor(deps: ShiftDeps): AttestDeps {
  return {
    wallet: deps.signer?.wallet ?? null,
    // Never read when wallet is null: attest returns { skipped: 'disabled' } first.
    publicClient: (deps.signer?.publicClient ?? null) as unknown as AnyPublicClient,
    budget: (wei) => deps.budget('gas_wei', wei),
    release: async (wei) => { await deps.release?.('gas_wei', wei); },
  };
}

export const DEFAULT_SITE_URL = 'https://lights-on.vercel.app';
export function siteUrlOf(deps: Pick<ShiftDeps, 'siteUrl'>): string {
  return (deps.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function envAgentId(raw: string | undefined): bigint {
  return raw && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Production deps. `shiftId` binds the per-shift LLM and GitHub caps; live runs get a 3-call GitHub cap per run.
 * Reads process.env directly (not the zod proxy) so a missing optional variable degrades instead of throwing.
 */
export function makeShiftDeps(db: Db, opts: { kind: Kind; shiftId?: number; onFinalized?: ShiftDeps['onFinalized'] }): ShiftDeps {
  const env = process.env;
  const now = () => new Date();
  const day = () => utcDay(now());
  let localGithub = 0;

  const budget = async (field: BudgetField, amount: number | bigint): Promise<boolean> => {
    switch (field) {
      case 'llm_tokens': {
        const d = day();
        if (!(await bumpBudget(db, d, 'llm_tokens', amount, CAPS.llmTokensPerDay))) return false;
        if (opts.shiftId !== undefined && !(await bumpShiftBudget(db, opts.shiftId, 'llm_tokens', amount, CAPS.llmTokensPerShift))) {
          await releaseBudget(db, d, 'llm_tokens', amount);
          return false;
        }
        return true;
      }
      case 'github_calls': {
        const n = Number(amount);
        if (opts.kind === 'live') {
          if (localGithub + n > CAPS.githubCallsPerLiveRun) return false;
          if (!(await bumpBudget(db, day(), 'github_calls', n, CAPS.githubLiveCallsPerDay))) return false;
          localGithub += n;
          return true;
        }
        if (opts.shiftId !== undefined) return bumpShiftBudget(db, opts.shiftId, 'github_calls', n, CAPS.githubCallsPerNight);
        if (localGithub + n > CAPS.githubCallsPerNight) return false;
        localGithub += n;
        return true;
      }
      case 'gas_wei':
        return bumpBudget(db, day(), 'gas_wei', amount, CAPS.gasWeiPerDay);
      case 'live_runs':
        return bumpBudget(db, day(), 'live_runs', amount, CAPS.liveRunsPerDay);
    }
  };

  const rpcUrl = env.BASE_RPC_URL || DEFAULT_BASE_RPC;
  const wallet = getWallet(rpcUrl);
  return {
    db,
    fetch: (url, init) => safeFetch(url, init),
    now,
    budget,
    release: (field, amount) => releaseBudget(db, day(), field, amount),
    attest: attestOne,
    attestMany,
    explain: explainNight,
    onFinalized: opts.onFinalized,
    signer: wallet ? { wallet, publicClient: getPublicClient(rpcUrl) } : undefined,
    rpc: getBaseClient(),
    githubToken: env.GITHUB_READ_TOKEN || undefined,
    agentId: envAgentId(env.WATCHER_AGENT_ID),
    siteUrl: env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL,
  };
}
