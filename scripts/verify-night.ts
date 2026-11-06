// pnpm tsx scripts/verify-night.ts --network base|fork --uid 0x.. --bundle evidence.json [--attester 0x..[,0x..]]
// Re-hashes the published evidence bundle and checks it against the on-chain attestation: schema, attester allowlist
// (default NEXT_PUBLIC_WATCHER_ADDRESS), not revoked/expired, project, night, evidenceHash. Read-only. Exit 0 only on full match.
import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { verifyNight } from '../src/lib/attest/verify';
import type { EvidenceBundle } from '../src/lib/types';
import { arg, connect } from './_net';

async function main() {
  const uid = arg('uid') as `0x${string}` | undefined;
  const file = arg('bundle');
  const attesters = (arg('attester') ?? process.env.NEXT_PUBLIC_WATCHER_ADDRESS ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Address[];
  if (!uid || !file) throw new Error('usage: --network base|fork --uid <attestation uid> --bundle <evidence.json> [--attester 0x..[,0x..]]');
  if (attesters.length === 0) throw new Error('no attester: pass --attester or set NEXT_PUBLIC_WATCHER_ADDRESS');
  const bundle = JSON.parse(readFileSync(file, 'utf8')) as EvidenceBundle;
  const { publicClient } = connect(false);
  const r = await verifyNight(uid, bundle, publicClient, attesters);
  for (const [k, v] of Object.entries(r.checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  console.log(JSON.stringify({ match: r.match, onchainHash: r.onchainHash, localHash: r.localHash, attester: r.attester }));
  process.exit(r.match ? 0 : 2);
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : 'error'); process.exit(1); });
