// pnpm tsx scripts/verify-night.ts --network base|fork --uid 0x.. --bundle evidence.json
// Re-hashes the published evidence bundle and compares it to the evidenceHash attested on-chain. Read-only.
import { readFileSync } from 'node:fs';
import { verifyNight } from '../src/lib/attest/verify';
import type { EvidenceBundle } from '../src/lib/types';
import { arg, connect } from './_net';

async function main() {
  const uid = arg('uid') as `0x${string}` | undefined;
  const file = arg('bundle');
  if (!uid || !file) throw new Error('usage: --uid <attestation uid> --bundle <evidence.json>');
  const bundle = JSON.parse(readFileSync(file, 'utf8')) as EvidenceBundle;
  const { publicClient } = connect(false);
  const r = await verifyNight(uid, bundle, publicClient);
  console.log(JSON.stringify(r));
  process.exit(r.match ? 0 : 2);
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split('\n')[0] : 'error'); process.exit(1); });
