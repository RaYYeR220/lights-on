// pnpm tsx scripts/verify-night.ts --network base|fork --uid 0x.. --bundle evidence.json [--attester 0x..[,0x..]] [--site https://..]
// Re-hashes the published evidence bundle and checks it against the attestation on Base: attester allowlist (default
// NEXT_PUBLIC_WATCHER_ADDRESS), not revoked/expired, night, and
//   - a nightly night (one Merkle root per night): fetches the row's status, lit30 and Merkle proof from the site's REST
//     API (--site, default NEXT_PUBLIC_SITE_URL), rebuilds the leaf from the bundle + row, and checks the proof reaches
//     the attested root. The row is untrusted input: a wrong value simply fails the proof.
//   - a live run (per-project attestation): project, night and evidenceHash field by field.
// Read-only. Exit 0 only on a full match (2 on a mismatch, 1 on an error).
import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { verifyNight, type RootRow } from '../src/lib/attest/verify';
import { siteUrl } from '../src/lib/site';
import type { EvidenceBundle, Status } from '../src/lib/types';
import { arg, connect } from './_net';

interface RestNight { night: number; observed: boolean; status: Status; evidenceHash: string | null; attestationUid: string | null; attestProof: string[] | null; attestLit30: number | null }

/** The observed row of this bundle's project-night, as the site publishes it. */
async function fetchRow(site: string, b: EvidenceBundle): Promise<RestNight | null> {
  const url = `${site.replace(/\/+$/, '')}/api/v1/projects/${encodeURIComponent(b.project)}/nights?from=${b.night}&to=${b.night}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`row fetch failed: HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { nights?: RestNight[] };
  return body.nights?.find((n) => n.observed && n.night === b.night) ?? null;
}

async function main() {
  const file = arg('bundle');
  const attesters = (arg('attester') ?? process.env.NEXT_PUBLIC_WATCHER_ADDRESS ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Address[];
  if (!file) throw new Error('usage: --network base|fork --uid <attestation uid> --bundle <evidence.json> [--attester 0x..[,0x..]] [--site <origin>]');
  if (attesters.length === 0) throw new Error('no attester: pass --attester or set NEXT_PUBLIC_WATCHER_ADDRESS');
  const bundle = JSON.parse(readFileSync(file, 'utf8')) as EvidenceBundle;

  let row: RootRow | undefined;
  let uid = arg('uid') as Hex | undefined;
  if (bundle.kind === 'nightly') {
    const site = arg('site') ?? siteUrl();
    const r = await fetchRow(site, bundle);
    if (!r) console.log(`no observed row for ${bundle.project} on ${bundle.night} at ${site}`);
    else if (!r.attestProof || r.attestLit30 === null) console.log('the row carries no Merkle proof (not attested yet)');
    else row = { status: r.status, lit30: r.attestLit30, proof: r.attestProof, evidenceHash: r.evidenceHash };
    uid ??= (r?.attestationUid ?? undefined) as Hex | undefined;
  }
  if (!uid) throw new Error('no attestation uid: pass --uid');

  const { publicClient } = connect(false);
  const v = await verifyNight(uid, bundle, publicClient, attesters, row ? { row } : {});
  console.log(`mode: ${v.mode === 'root' ? 'nightly root (Merkle proof)' : 'per-project attestation'}`);
  for (const [k, ok] of Object.entries(v.checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${k}`);
  if (v.mode === 'root' && v.root) {
    console.log(`Merkle proof · ${v.proofSteps ?? 0} step${v.proofSteps === 1 ? '' : 's'} → root ${v.root} (${v.count} project-nights) · manifest ${v.manifestURI}`);
  }
  console.log(JSON.stringify({ match: v.match, mode: v.mode, onchainHash: v.onchainHash, localHash: v.localHash, attester: v.attester }));
  process.exit(v.match ? 0 : 2);
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : 'error'); process.exit(1); });
