// pnpm tsx scripts/register-agent.ts --network base|fork --uri https://site/.well-known/agent-registration.json
import { registerAgent } from '../src/lib/attest/erc8004';
import { arg, connect } from './_net';

async function main() {
  const uri = arg('uri');
  if (!uri) throw new Error('usage: --uri <agentURI>');
  const { publicClient, wallet } = connect(true);
  const r = await registerAgent(uri, { wallet: wallet!, publicClient });
  console.log(JSON.stringify({ agentId: r.agentId.toString(), txHash: r.txHash, owner: wallet!.account.address }));
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split('\n')[0] : 'error'); process.exit(1); });
