import type { Address, Hex } from 'viem';
import type { Db } from '@/lib/db';
import {
  bumpBudget, bumpShiftBudget, releaseBudget, releaseShiftBudget, type BudgetField,
} from '@/lib/db/queries';
import { checkLiveAppDetailed } from '@/lib/adapters/liveapp';
import { checkRepoDetailed, type FetchLike } from '@/lib/adapters/repo';
import { checkChain } from '@/lib/adapters/chain';
import { checkVibestarter } from '@/lib/adapters/vibestarter';
import { DEFAULT_BASE_RPC, getBaseClient, type RpcLike } from '@/lib/adapters/baseRpc';
import { attestMany, attestOne, attestationStatus, type AttestDeps, type AttestReceipt } from '@/lib/attest/eas';
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
  /** Refund a reservation (gas before broadcast, unused LLM tokens, a lost live-run race). */
  release?: (field: BudgetField, amount: number | bigint) => Promise<void>;
  attest: typeof attestOne;
  attestMany: typeof attestMany;
  explain: typeof explainNight;
  /** Task 12 hook (briefings); called once per shift, by the finalize that closes it. */
  onFinalized?: (shiftId: number) => Promise<void>;
  /** Test seams / overrides; defaults are the real adapters. */
  adapters?: Partial<Adapters>;
  /** Watcher wallet + read client; wallet null -> attestation `disabled`. */
  signer?: { wallet: AttestDeps['wallet']; publicClient: AnyPublicClient };
  /** Settles a broadcast tx from its receipt, nonce and recorded sender (defaults to attestationStatus on signer.publicClient). */
  attestReceipt?: (txHash: Hex, nonce: number | null, sender: Address | null) => Promise<AttestReceipt>;
  /** Base RPC for chain/vibestarter adapters (defaults to getBaseClient() inside them). */
  rpc?: RpcLike;
  githubToken?: string;
  /** ERC-8004 agent id of the watcher. Missing or 0 -> nothing is attested. */
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

/** An attestation needs a registered watcher identity: never attest with agentId 0. */
export function canAttest(deps: Pick<ShiftDeps, 'agentId'>): boolean {
  return typeof deps.agentId === 'bigint' && deps.agentId > 0n;
}

export function attestDepsFor(
  deps: ShiftDeps, onBroadcast?: AttestDeps['onBroadcast'], opts: { receiptTimeoutMs?: number } = {},
): AttestDeps {
  return {
    wallet: canAttest(deps) ? deps.signer?.wallet ?? null : null,
    // Never read when wallet is null: attest returns { skipped: 'disabled' } first.
    publicClient: (deps.signer?.publicClient ?? null) as unknown as AnyPublicClient,
    budget: (wei) => deps.budget('gas_wei', wei),
    release: async (wei) => { await deps.release?.('gas_wei', wei); },
    ...(onBroadcast ? { onBroadcast } : {}),
    ...(opts.receiptTimeoutMs ? { receiptTimeoutMs: opts.receiptTimeoutMs } : {}),
  };
}

/** The nonce is checked against the sender recorded with the tx, never against whatever key is configured now. */
export function receiptOf(deps: ShiftDeps): ((txHash: Hex, nonce: number | null, sender: Address | null) => Promise<AttestReceipt>) | null {
  if (deps.attestReceipt) return deps.attestReceipt;
  const pc = deps.signer?.publicClient;
  return pc ? (tx, nonce, sender) => attestationStatus(tx, nonce, sender, pc) : null;
}

export const DEFAULT_SITE_URL = 'https://lights-on.vercel.app';
export function siteUrlOf(deps: Pick<ShiftDeps, 'siteUrl'>): string {
  return (deps.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function envAgentId(raw: string | undefined): bigint {
  return raw && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Production deps. `shiftId` binds the per-shift LLM and GitHub caps. Live runs share the daily gas/LLM counters with
 * the nightly shift but stop `nightlyReserve` short of the cap, so public traffic can never starve the nightly
 * attestation; live runs also get a 3-call GitHub cap per run.
 * Reads process.env directly (not the zod proxy) so a missing optional variable degrades instead of throwing.
 */
export function makeShiftDeps(db: Db, opts: { kind: Kind; shiftId?: number; onFinalized?: ShiftDeps['onFinalized'] }): ShiftDeps {
  const env = process.env;
  const now = () => new Date();
  const day = () => utcDay(now());
  const live = opts.kind === 'live';
  const llmDayCap = live ? CAPS.llmTokensPerDay - CAPS.nightlyReserveTokens : CAPS.llmTokensPerDay;
  const gasDayCap = live ? CAPS.gasWeiPerDay - CAPS.nightlyReserveWei : CAPS.gasWeiPerDay;
  let localGithub = 0;

  const budget = async (field: BudgetField, amount: number | bigint): Promise<boolean> => {
    switch (field) {
      case 'llm_tokens': {
        const d = day();
        if (!(await bumpBudget(db, d, 'llm_tokens', amount, llmDayCap))) return false;
        if (opts.shiftId !== undefined && !(await bumpShiftBudget(db, opts.shiftId, 'llm_tokens', amount, CAPS.llmTokensPerShift))) {
          await releaseBudget(db, d, 'llm_tokens', amount);
          return false;
        }
        return true;
      }
      case 'github_calls': {
        const n = Number(amount);
        if (live) {
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
        return bumpBudget(db, day(), 'gas_wei', amount, gasDayCap);
      case 'live_runs':
        return bumpBudget(db, day(), 'live_runs', amount, CAPS.liveRunsPerDay);
    }
  };

  const release = async (field: BudgetField, amount: number | bigint): Promise<void> => {
    await releaseBudget(db, day(), field, amount);
    if (field === 'llm_tokens' && opts.shiftId !== undefined) await releaseShiftBudget(db, opts.shiftId, 'llm_tokens', amount);
  };

  const rpcUrl = env.BASE_RPC_URL || DEFAULT_BASE_RPC;
  return {
    db,
    fetch: (url, init) => safeFetch(url, init),
    now,
    budget,
    release,
    attest: attestOne,
    attestMany,
    explain: explainNight,
    onFinalized: opts.onFinalized,
    signer: { wallet: getWallet(rpcUrl), publicClient: getPublicClient(rpcUrl) },
    rpc: getBaseClient(),
    githubToken: env.GITHUB_READ_TOKEN || undefined,
    agentId: envAgentId(env.WATCHER_AGENT_ID),
    siteUrl: env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL,
  };
}
