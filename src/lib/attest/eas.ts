import {
  decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseEventLogs, parseAbiParameters,
  zeroAddress, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient,
} from 'viem';
import { safeErrorCode } from '@/lib/net/redact';
import { EAS_ADDRESS, easAbi } from './abi';
import type { AnyPublicClient } from './signer';

/** Per-project schema: every live run (kind 1) is one attestation under it. */
export const SCHEMA =
  'bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI';

/**
 * Nightly root schema: one attestation per night (per claim batch) whose `root` is the Merkle root of every
 * project-night of the batch (leaf encoding in ./manifest.ts). `manifestURI` serves the canonical manifest of leaves.
 */
export const ROOT_SCHEMA = 'bytes32 root,uint32 night,uint16 count,uint256 agentId,string manifestURI';

export interface NightAttestation {
  projectKey: Hex; night: number; kind: 0 | 1; status: 1 | 2 | 3 | 4 | 5;
  lit30: number; evidenceHash: Hex; agentId: bigint; evidenceURI: string;
}

export interface NightRoot { root: Hex; night: number; count: number; agentId: bigint; manifestURI: string }

/**
 * Not attested. `txHash` is set whenever a signed tx was handed to the network (send error, receipt wait failed,
 * reverted, replaced, or logs unreadable): its fate must then be settled from the chain, never by sending the same
 * attestations again. `error: 'reverted'` with a txHash = confirmed revert (receipt status reverted).
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
   * Called after local signing and BEFORE the raw tx is sent, with its hash, nonce and sender, so the caller can
   * persist them first. If it throws, nothing is sent (the attestation is skipped, the reservation refunded).
   * Without it nothing is sent at all (`error: 'no_persist'`), unless `unsafeNoPersist` is set.
   */
  onBroadcast?: (txHash: Hex, nonce: number, sender: Address) => Promise<void>;
  /** Fork tests only: send without persisting the hash first. Never set in production. */
  unsafeNoPersist?: true;
  /** Receipt wait; default RECEIPT_TIMEOUT_MS. */
  receiptTimeoutMs?: number;
}

/** Production attest deps: the tx hash is always persisted before the raw tx is sent. */
export type PersistingAttestDeps = AttestDeps & {
  onBroadcast: NonNullable<AttestDeps['onBroadcast']>;
  unsafeNoPersist?: never;
};

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
const ROOT_PARAMS = parseAbiParameters(ROOT_SCHEMA);
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

const uidOf = (schema: string, resolver: Address, revocable: boolean): Hex =>
  keccak256(encodePacked(['string', 'address', 'bool'], [schema, resolver, revocable]));

/** UID of the per-project schema (live runs). */
export function schemaUid(resolver: Address = zeroAddress, revocable = false): Hex {
  return uidOf(SCHEMA, resolver, revocable);
}

/** UID of the nightly root schema. */
export function rootSchemaUid(resolver: Address = zeroAddress, revocable = false): Hex {
  return uidOf(ROOT_SCHEMA, resolver, revocable);
}

export function encodeNight(n: NightAttestation): Hex {
  return encodeAbiParameters(PARAMS, [n.projectKey, n.night, n.kind, n.status, n.lit30, n.evidenceHash, n.agentId, n.evidenceURI]);
}

export function decodeNight(data: Hex): NightAttestation {
  const [projectKey, night, kind, status, lit30, evidenceHash, agentId, evidenceURI] = decodeAbiParameters(PARAMS, data);
  return { projectKey, night, kind: kind as 0 | 1, status: status as 1 | 2 | 3 | 4 | 5, lit30, evidenceHash, agentId, evidenceURI };
}

export function encodeRoot(r: NightRoot): Hex {
  return encodeAbiParameters(ROOT_PARAMS, [r.root, r.night, r.count, r.agentId, r.manifestURI]);
}

export function decodeRoot(data: Hex): NightRoot {
  const [root, night, count, agentId, manifestURI] = decodeAbiParameters(ROOT_PARAMS, data);
  return { root, night, count, agentId, manifestURI };
}

const request = (data: Hex) => ({ recipient: zeroAddress, expirationTime: 0n, revocable: false, refUID: ZERO32, data, value: 0n });
const requestData = (n: NightAttestation) => request(encodeNight(n));

type Logs = readonly { address: string; topics: readonly Hex[]; data: Hex }[];

/**
 * Estimate worst-case cost, reserve it against the cap, sign locally with an explicit nonce, persist the hash
 * (onBroadcast, required unless `unsafeNoPersist`), then send the raw tx. Never throws. From the moment the hash is
 * persisted every outcome carries it and the reservation is kept, because the node may have accepted the tx even if
 * the send call failed.
 */
async function send(
  call: { functionName: 'attest' | 'multiAttest'; args: unknown },
  deps: AttestDeps,
): Promise<{ txHash: Hex; nonce: number; logs: Logs } | Skipped> {
  const { wallet, publicClient } = deps;
  if (!wallet) return { skipped: 'disabled' };
  // A hash that is not persisted before the send could be lost, and its rows sent again: refuse, reserve nothing.
  const persist = deps.onBroadcast;
  if (!persist && deps.unsafeNoPersist !== true) return { skipped: 'error', error: 'no_persist' };
  let sent: Hex | undefined;
  let nonce: number | undefined;
  try {
    const sender = wallet.account.address;
    const base = { address: EAS_ADDRESS, abi: easAbi, account: wallet.account, ...call } as never;
    const estimate = await publicClient.estimateContractGas(base);
    const gas = (estimate * 12n) / 10n;
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas == null) return { skipped: 'error', error: 'error' };
    const tipEstimate = await publicClient.estimateMaxPriorityFeePerGas();
    const { maxFeePerGas, maxPriorityFeePerGas } = computeFees(block.baseFeePerGas, tipEstimate);
    // Explicit nonce, so a tx that is never found can later be proven unmineable (a later tx consumed its nonce).
    const n = await publicClient.getTransactionCount({ address: sender, blockTag: 'pending' });
    const reserved = gas * maxFeePerGas;
    if (!(await deps.budget(reserved))) return { skipped: 'gas_cap' };
    let serialized: Hex;
    let hash: Hex;
    let signed = false;
    try {
      serialized = await wallet.signTransaction({
        account: wallet.account,
        chain: wallet.chain,
        to: EAS_ADDRESS,
        data: encodeFunctionData({ abi: easAbi, ...call } as never),
        value: 0n,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce: n,
        type: 'eip1559',
      } as never);
      signed = true;
      hash = keccak256(serialized);
      await persist?.(hash, n, sender); // persisted BEFORE it can reach any node
    } catch (e) {
      await deps.release?.(reserved).catch(() => undefined); // nothing was sent: refund
      return { skipped: 'error', error: signed ? 'persist_failed' : safeErrorCode(e) };
    }
    sent = hash;
    nonce = n;
    // Any failure from here on is post-broadcast from our side: keep the reservation and report the hash.
    await wallet.sendRawTransaction({ serializedTransaction: serialized });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS });
    // viem follows replacements and may hand back ANOTHER tx's receipt for our nonce: that is not ours.
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) return { skipped: 'error', error: 'replaced', txHash: hash, nonce: n };
    if (receipt.status !== 'success') return { skipped: 'error', error: 'reverted', txHash: hash, nonce: n };
    return { txHash: hash, nonce: n, logs: receipt.logs as unknown as Logs };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e), ...(sent ? { txHash: sent } : {}), ...(nonce !== undefined ? { nonce } : {}) };
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

/**
 * The nightly attestation: ONE `attest` under the root schema, however many project-nights the root covers. Same
 * send path as everything else (reserve, sign locally, persist, send); a mined tx must carry exactly one EAS
 * `Attested` log, anything else is `uid_count_mismatch` with the tx hash kept (settled later, never re-sent).
 */
export async function attestRoot(r: NightRoot, deps: AttestDeps): Promise<{ uid: Hex; txHash: Hex } | Skipped> {
  const valid = /^0x[0-9a-fA-F]{64}$/.test(r.root) && Number.isInteger(r.count) && r.count >= 1 && r.count <= 65_535
    && Number.isInteger(r.night) && r.night >= 20200101 && r.night <= 20991231;
  if (!valid) return { skipped: 'error', error: 'invalid_root' };
  const res = await send({ functionName: 'attest', args: [{ schema: rootSchemaUid(), data: request(encodeRoot(r)) }] }, deps);
  if ('skipped' in res) return res;
  try {
    const uids = uidsFrom(res.logs);
    if (uids.length !== 1) return { skipped: 'error', error: 'uid_count_mismatch', txHash: res.txHash, nonce: res.nonce };
    return { uid: uids[0], txHash: res.txHash };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e), txHash: res.txHash, nonce: res.nonce };
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
 *  dropped  - no receipt, the sender's mined tx count is past the tx nonce, and the node does not know the tx:
 *             another tx used the nonce, ours can never mine
 *  pending  - no receipt and the nonce is still open (or unknown): may still mine, so keep waiting
 *  error    - RPC failure: decide nothing
 */
export type AttestReceipt =
  | { status: 'success'; uids: Hex[] }
  | { status: 'reverted' }
  | { status: 'pending' }
  | { status: 'dropped' }
  | { status: 'error'; error: string };

const isNamed = (e: unknown, name: string) => {
  const named = (x: unknown) => (x as { name?: unknown } | null)?.name === name;
  return named(e) || named((e as { cause?: unknown } | null)?.cause);
};

/**
 * Settle a broadcast tx (sender = the address recorded with it). The sender's `latest` tx count is read BEFORE the
 * receipt; `dropped` needs all three: the nonce was already consumed then, the receipt is still missing, and the
 * node does not know the tx either (getTransaction not found), which guards against one lagging node of a
 * load-balanced RPC. Anything less certain is `pending`. Never throws.
 */
export async function attestationStatus(
  txHash: Hex,
  nonce: number | null,
  sender: Address | null,
  publicClient: Pick<AnyPublicClient, 'getTransactionReceipt' | 'getTransactionCount' | 'getTransaction'>,
): Promise<AttestReceipt> {
  try {
    const mined = nonce !== null && sender ? await publicClient.getTransactionCount({ address: sender, blockTag: 'latest' }) : null;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return { status: 'reverted' };
      return { status: 'success', uids: uidsFrom(receipt.logs as unknown as Logs) };
    } catch (e) {
      if (!isNamed(e, 'TransactionReceiptNotFoundError')) throw e;
      if (mined === null || nonce === null || !(mined > nonce)) return { status: 'pending' };
      try {
        const tx = await publicClient.getTransaction({ hash: txHash });
        return tx ? { status: 'pending' } : { status: 'dropped' };
      } catch (e2) {
        return isNamed(e2, 'TransactionNotFoundError') ? { status: 'dropped' } : { status: 'pending' };
      }
    }
  } catch (e) {
    return { status: 'error', error: safeErrorCode(e) };
  }
}
