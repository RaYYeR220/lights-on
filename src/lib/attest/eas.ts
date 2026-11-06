import {
  decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, parseEventLogs, parseAbiParameters, zeroAddress,
  type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { safeErrorCode } from '@/lib/net/redact';
import { EAS_ADDRESS, easAbi } from './abi';

export const SCHEMA =
  'bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI';

export interface NightAttestation {
  projectKey: Hex; night: number; kind: 0 | 1; status: 1 | 2 | 3 | 4 | 5;
  lit30: number; evidenceHash: Hex; agentId: bigint; evidenceURI: string;
}

export type Skipped = { skipped: 'gas_cap' | 'disabled' | 'error'; error?: string };

export interface AttestDeps {
  wallet: WalletClient<Transport, Chain | undefined, Account> | null;
  publicClient: PublicClient;
  /** Pre-bound by the caller: true = wei reserved against the daily gas cap, false = over cap. */
  budget: (weiAmount: bigint) => Promise<boolean>;
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

/** Estimate worst-case cost, reserve it against the cap, then send. Never throws. */
async function send(
  call: { functionName: 'attest' | 'multiAttest'; args: unknown },
  deps: AttestDeps,
): Promise<{ txHash: Hex; logs: Logs } | Skipped> {
  const { wallet, publicClient } = deps;
  if (!wallet) return { skipped: 'disabled' };
  try {
    const base = { address: EAS_ADDRESS, abi: easAbi, account: wallet.account, ...call } as never;
    const gas = await publicClient.estimateContractGas(base);
    const fees = await publicClient.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFee === undefined) return { skipped: 'error', error: 'error' };
    if (!(await deps.budget(gas * maxFee))) return { skipped: 'gas_cap' };
    const txHash = await wallet.writeContract({ ...(base as object), chain: wallet.chain, gas, maxFeePerGas: maxFee } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return { skipped: 'error', error: 'reverted' };
    return { txHash, logs: receipt.logs as unknown as Logs };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e) };
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
    if (!uid) return { skipped: 'error', error: 'no_attested_log' };
    return { uid, txHash: r.txHash };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e) };
  }
}

export async function attestMany(ns: NightAttestation[], deps: AttestDeps): Promise<{ uids: Hex[]; txHash: Hex } | Skipped> {
  if (ns.length === 0) return { skipped: 'error', error: 'empty' };
  const r = await send({ functionName: 'multiAttest', args: [[{ schema: schemaUid(), data: ns.map(requestData) }]] }, deps);
  if ('skipped' in r) return r;
  try {
    const uids = uidsFrom(r.logs);
    if (uids.length !== ns.length) return { skipped: 'error', error: 'uid_count_mismatch' };
    return { uids, txHash: r.txHash };
  } catch (e) {
    return { skipped: 'error', error: safeErrorCode(e) };
  }
}
