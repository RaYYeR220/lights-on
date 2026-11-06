// pnpm tsx scripts/register-schema.ts --network base|fork   (WATCHER_PRIVATE_KEY from env)
import { SCHEMA_REGISTRY_ADDRESS, schemaRegistryAbi } from '../src/lib/attest/abi';
import { SCHEMA, schemaUid } from '../src/lib/attest/eas';
import { zeroAddress } from 'viem';
import { connect } from './_net';

async function main() {
  const { publicClient, wallet } = connect(true);
  const uid = schemaUid();
  const existing = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
  if (existing.uid !== '0x' + '00'.repeat(32)) {
    console.log(JSON.stringify({ status: 'already_registered', uid }));
    return;
  }
  const txHash = await wallet!.writeContract({
    address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'register',
    args: [SCHEMA, zeroAddress, false], chain: wallet!.chain, account: wallet!.account,
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (rc.status !== 'success') throw new Error('register reverted');
  const onchain = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
  if (onchain.uid !== uid || onchain.schema !== SCHEMA) throw new Error('schema uid mismatch after register');
  console.log(JSON.stringify({ status: 'registered', uid, txHash }));
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split('\n')[0] : 'error'); process.exit(1); });
