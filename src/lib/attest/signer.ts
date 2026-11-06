import { createPublicClient, createWalletClient, http, isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

export const BASE_READ_RPC = 'https://base-rpc.publicnode.com';

/** Wallet from WATCHER_PRIVATE_KEY, or null when unset/invalid (attestation then reports skipped:'disabled'). */
export function getWallet(rpcUrl: string, key: string | undefined = process.env.WATCHER_PRIVATE_KEY) {
  if (!key) return null;
  const k = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  if (!isHex(k) || k.length !== 66) return null;
  return createWalletClient({ account: privateKeyToAccount(k), chain: base, transport: http(rpcUrl) });
}

export function getPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

/** viem's chain-specific client types (Base adds OP-stack block/tx shapes) are not assignable to the generic PublicClient. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPublicClient = import('viem').PublicClient<import('viem').Transport, any, any>;
