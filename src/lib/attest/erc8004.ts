import { parseEventLogs, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem';
import { IDENTITY_REGISTRY_ADDRESS, identityRegistryAbi } from './abi';

export async function registerAgent(
  agentURI: string,
  deps: { wallet: WalletClient<Transport, Chain | undefined, Account>; publicClient: PublicClient },
): Promise<{ agentId: bigint; txHash: Hex }> {
  const { wallet, publicClient } = deps;
  const txHash = await wallet.writeContract({
    address: IDENTITY_REGISTRY_ADDRESS, abi: identityRegistryAbi, functionName: 'register', args: [agentURI],
    chain: wallet.chain, account: wallet.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error('register_reverted');
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === IDENTITY_REGISTRY_ADDRESS.toLowerCase());
  const reg = parseEventLogs({ abi: identityRegistryAbi, eventName: 'Registered', logs })[0];
  if (reg) return { agentId: reg.args.agentId, txHash };
  const tr = parseEventLogs({ abi: identityRegistryAbi, eventName: 'Transfer', logs })
    .find((l) => l.args.to.toLowerCase() === wallet.account.address.toLowerCase());
  if (!tr) throw new Error('agent_id_not_found');
  return { agentId: tr.args.tokenId, txHash };
}
