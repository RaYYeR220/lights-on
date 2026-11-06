import { BASE_READ_RPC, getPublicClient, getWallet } from '../src/lib/attest/signer';

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** --network base (BASE_RPC_URL or public node) | fork (FORK_RPC_URL or local anvil on :8546). */
export function connect(needWallet: boolean) {
  const net = arg('network');
  if (net !== 'base' && net !== 'fork') throw new Error('usage: --network base|fork');
  const rpc = net === 'fork' ? (process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8546') : (process.env.BASE_RPC_URL ?? BASE_READ_RPC);
  const publicClient = getPublicClient(rpc);
  const wallet = needWallet ? getWallet(rpc) : null;
  if (needWallet && !wallet) throw new Error('WATCHER_PRIVATE_KEY missing or invalid (env only)');
  return { net, publicClient, wallet };
}
