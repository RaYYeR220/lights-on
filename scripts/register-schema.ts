// pnpm tsx scripts/register-schema.ts --network base|fork [--which root|single|both]   (WATCHER_PRIVATE_KEY from env)
// root = the nightly Merkle-root schema (one attestation per night), single = the per-project schema (live runs).
// Default both. Idempotent: an already registered schema is reported, not registered again.
import { SCHEMA_REGISTRY_ADDRESS, schemaRegistryAbi } from '../src/lib/attest/abi';
import { ROOT_SCHEMA, SCHEMA, rootSchemaUid, schemaUid } from '../src/lib/attest/eas';
import { zeroAddress, type Hex } from 'viem';
import { arg, connect } from './_net';

const SCHEMAS = {
  root: { schema: ROOT_SCHEMA, uid: rootSchemaUid },
  single: { schema: SCHEMA, uid: schemaUid },
} as const;

async function main() {
  const which = arg('which') ?? 'both';
  if (which !== 'root' && which !== 'single' && which !== 'both') throw new Error('usage: --which root|single|both');
  const names: (keyof typeof SCHEMAS)[] = which === 'both' ? ['root', 'single'] : [which];
  const { publicClient, wallet } = connect(true);
  for (const name of names) {
    const { schema, uid: uidOf } = SCHEMAS[name];
    const uid: Hex = uidOf();
    const existing = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
    if (existing.uid !== '0x' + '00'.repeat(32)) {
      console.log(JSON.stringify({ schema: name, status: 'already_registered', uid }));
      continue;
    }
    const txHash = await wallet!.writeContract({
      address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'register',
      args: [schema, zeroAddress, false], chain: wallet!.chain, account: wallet!.account,
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (rc.status !== 'success') throw new Error(`register reverted (${name})`);
    const onchain = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
    if (onchain.uid !== uid || onchain.schema !== schema) throw new Error(`schema uid mismatch after register (${name})`);
    console.log(JSON.stringify({ schema: name, status: 'registered', uid, txHash }));
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split('\n')[0] : 'error'); process.exit(1); });
