import {
  decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, parseEventLogs, parseAbiParameters, zeroAddress,
  type Account, type Address, type Chain, type Hex, type Transport, type WalletClient,
} from 'viem';
import { safeErrorCode } from '@/lib/net/redact';
import { EAS_ADDRESS, easAbi } from './abi';
import type { AnyPublicClient } from './signer';

export const SCHEMA =
  'bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI';

export interface NightAttestation {
  projectKey: Hex; night: number; kind: 0 | 1; status: 1 | 2 | 3 | 4 | 5;
  lit30: number; evidenceHash: Hex; agentId: bigint; evidenceURI: string;
}

/**
 * Not attested. `txHash` is set whenever the tx WAS broadcast (receipt wait failed, reverted, or logs unreadable):
 * its fate must then be settled from the receipt, never by sending the same attestations again.
 * `error: 'reverted'` with a txHash = confirmed revert (receipt status reverted).
 */
export type Skipped = { skipped: 'gas_cap' | 'disabled' | 'error'; error?: string; txHash?: Hex; nonce?: number };

export interface AttestDeps {
  wallet: WalletClient<Transport, Chain | undefined, Account> | null;
  publicClient: AnyPublicClient;
  /** Pre-bound by the caller: true = wei reserved against the daily gas cap, false = over cap. */
  budget: (weiAmount: bigint) => Promise<boolean>;
  /**
   * Optional refund of a reservation. Called ONLY for failures before broadcast (the tx was never sent, e.g. signing
   * or submission rejected). Once a tx hash exists the reservation is kept, even if the tx later reverts.
   * Estimate/fee-read failures happen before anything is reserved, so they need no release.
   */
  release?: (weiAmount: bigint) => Promise<void>;
  /**
   * Called right after broadcast, before the receipt wait, with the hash and the nonce it was signed with, so the
   * caller can persist both. Errors are ignored.
   */
  onBroadcast?: (txHash: Hex, nonce: number) => Promise<void>;
  /** Receipt wait; default RECEIPT_TIMEOUT_MS. */
  receiptTimeoutMs?: number;
}

/** Receipt wait before giving up (the tx hash is returned, so nothing is lost). */
export const RECEIPT_TIMEOUT_MS = 60_000;

export const MIN_TIP_WEI = 1_000_000n; // 0.001 gwei
export const MAX_TIP_WEI = 10_000_000n; // 0.01 gwei

/** tip = clamp(estimatedTip, 0.001, 0.01 gwei); maxFee = 2 x baseFee + tip. */
export function computeFees(baseFee: bigint, estimatedTip: bigint) {
  const tip = estimatedTip < MIN_TIP_WEI ? MIN_TIP_WEI : estimatedTip > MAX_TIP_WEI ? MAX_TIP_WEI : estimatedTip;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * baseFee + tip };
}

const PARAMS = parseAbiParameters(SCHEMA);
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

export function schemaUid(resolver: Address = zeroAddress, revocable = false): Hex {
  return keccak256(encodePacked(['string', 'address', 'bool'], [SCHEMA, resolver, revocable]));
}

export function encodeNight(n: NightAttestation): Hex {
  return encodeAbiParameters(PARAMS, [n.projectKey, n.night, n.kind, n.status, n.lit30, n.evidenceHash, n.agentId, n.evidenceURI]);
}

export function decodeNight(data: Hex): NightAttestation {
  const [projectKey, night, kind, status, lit30, evidenceHash, agentId, evidenceURI] = decodeAbiParameters(PARAMS, data);
  return { projectKey, night, kind: kind as 0 | 1, status: status as 1 | 2 | 3 | 4 | 5, lit30, evidenceHash, agentId, evidenceURI };
}

function requestData(n: NightAttestation) {
  return { recipient: zeroAddress, expirationTime: 0n, revocable: false, refUID: ZERO32, data: encodeNight(n), value: 0n };
}

type Logs = readonly { address: string; topics: readonly Hex[]; data: Hex }[];

/** Estimate worst-case cost, reserve it against the cap, then send. Never throws; after broadcast always reports txHash. */
async function send(
  call: { functionName: 'attest' | 'multiAttest'; args: unknown },
  deps: AttestDeps,
): Promise<{ txHash: Hex; nonce: number; logs: Logs } | Skipped> {
  const { wallet, publicClient } = deps;
  if (!wallet) return { skipped: 'disabled' };
  let txHash: Hex | undefined;
  let nonce: number | undefined;
  try {
    const base = { address: EAS_ADDRESS, abi: easAbi, account: wallet.account, ...call } as never;
    const estimate = await publicClient.estimateContractGas(base);
    const gas = (estimate * 12n) / 10n;
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas == null) return { skipped: 'error', error: 'error' };
    const tipEstimate = await publicClient.estimateMaxPriorityFeePerGas();
    const { maxFeePerGas, maxPriorityFeePerGas } = computeFees(block.baseFeePerGas, tipEstimate);
    // Explicit nonce, so a tx that is never found can later be proven unmineable (a later tx consumed its nonce).
    const n = await publicClient.getTransactionCount({ address: wallet.account.address, blockTag: 'pending' });
    const reserved = gas * maxFeePerGas;
    if (!(await deps.budget(reserved))) return { skipped: 'gas_cap' };
    try {
      txHash = await wallet.writeContract({ ...(base as object), chain: wallet.chain, gas, maxFeePerGas, maxPriorityFeePerGas, nonce: n } as never);
    } catch (e) {
      await deps.release?.(reserved).catch(() => undefined); // never broadcast: refund
      return { skipped: 'error', error: safeErrorCode(e) };
    }
    const sent = txHash;
    nonce = n;
    await deps.onBroadcast?.(sent, n).catch(() => undefined);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: sent, timeout: deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') return { skipped: 'error', error: 'reverted', txHash: sent, nonce: n };
    return { txHash: sent, nonce: n, logs: receipt.logs as unknown as Logs };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e), ...(txHash ? { txHash } : {}), ...(nonce !== undefined ? { nonce } : {}) };
  }
}

function uidsFrom(logs: Logs): Hex[] {
  const own = logs.filter((l) => l.address.toLowerCase() === EAS_ADDRESS.toLowerCase());
  return parseEventLogs({ abi: easAbi, eventName: 'Attested', logs: own as never }).map((l) => l.args.uid as Hex);
}

export async function attestOne(n: NightAttestation, deps: AttestDeps): Promise<{ uid: Hex; txHash: Hex } | Skipped> {
  const r = await send({ functionName: 'attest', args: [{ schema: schemaUid(), data: requestData(n) }] }, deps);
  if ('skipped' in r) return r;
  try {
    const [uid] = uidsFrom(r.logs);
    if (!uid) return { skipped: 'error', error: 'no_attested_log', txHash: r.txHash, nonce: r.nonce };
    return { uid, txHash: r.txHash };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e), txHash: r.txHash, nonce: r.nonce };
  }
}

export async function attestMany(ns: NightAttestation[], deps: AttestDeps): Promise<{ uids: Hex[]; txHash: Hex } | Skipped> {
  if (ns.length === 0) return { skipped: 'error', error: 'empty' };
  const r = await send({ functionName: 'multiAttest', args: [[{ schema: schemaUid(), data: ns.map(requestData) }]] }, deps);
  if ('skipped' in r) return r;
  try {
    const uids = uidsFrom(r.logs);
    if (uids.length !== ns.length) return { skipped: 'error', error: 'uid_count_mismatch', txHash: r.txHash, nonce: r.nonce };
    return { uids, txHash: r.txHash };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e), txHash: r.txHash, nonce: r.nonce };
  }
}

/**
 * Fate of a broadcast attestation tx.
 *  success  - mined; uids of the EAS `Attested` logs in log order (= request order for multiAttest)
 *  reverted - mined, reverted: nothing attested
 *  dropped  - no receipt AND the sender's mined tx count is past the tx nonce: another tx used the nonce, ours can
 *             never mine
 *  pending  - no receipt and the nonce is still open (or unknown): may still mine, so keep waiting
 *  error    - RPC failure: decide nothing
 */
export type AttestReceipt =
  | { status: 'success'; uids: Hex[] }
  | { status: 'reverted' }
  | { status: 'pending' }
  | { status: 'dropped' }
  | { status: 'error'; error: string };

const notFound = (e: unknown) => {
  const named = (x: unknown) => (x as { name?: unknown } | null)?.name === 'TransactionReceiptNotFoundError';
  return named(e) || named((e as { cause?: unknown } | null)?.cause);
};

/**
 * Settle a broadcast tx. The sender's `latest` tx count is read BEFORE the receipt: if the nonce was already consumed
 * then and the receipt is still missing afterwards, the consuming tx was not ours. Never throws.
 */
export async function attestationStatus(
  txHash: Hex,
  nonce: number | null,
  sender: Address | null,
  publicClient: Pick<AnyPublicClient, 'getTransactionReceipt' | 'getTransactionCount'>,
): Promise<AttestReceipt> {
  try {
    const mined = nonce !== null && sender ? await publicClient.getTransactionCount({ address: sender, blockTag: 'latest' }) : null;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return { status: 'reverted' };
      return { status: 'success', uids: uidsFrom(receipt.logs as unknown as Logs) };
    } catch (e) {
      if (!notFound(e)) throw e;
      return mined !== null && nonce !== null && mined > nonce ? { status: 'dropped' } : { status: 'pending' };
    }
  } catch (e) {
    return { status: 'error', error: safeErrorCode(e) };
  }
}
