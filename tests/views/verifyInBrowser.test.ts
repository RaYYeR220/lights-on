import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { encodeRoot, rootSchemaUid } from '@/lib/attest/eas';
import { buildNightManifest } from '@/lib/attest/manifest';
import type { AnyPublicClient } from '@/lib/attest/signer';
import { canonicalize, hashEvidence } from '@/lib/shift/evidence';
import { verifyInBrowser } from '@/components/project/verifyInBrowser';
import type { EvidenceBundle } from '@/lib/types';

const WATCHER = '0x00000000000000000000000000000000000000aa' as Address;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const TX = ('0x' + 'ab'.repeat(32)) as Hex;
const bundle = (project: string): EvidenceBundle => ({
  v: 1, rulesVersion: 'r1', project, night: 20261106, kind: 'nightly',
  window: { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' },
  sources: { repo: null, liveapp: null, chain: null, vibestarter: null },
});

function setup() {
  const bundles = ['alpha', 'beta', 'gamma'].map(bundle);
  const m = buildNightManifest(bundles.map((b) => ({ slug: b.project, night: 20261106, status: 'unavailable' as const, lit30: 0, evidenceHash: hashEvidence(b) })), 7n);
  const uid = keccak256(toBytes('root'));
  const client = {
    readContract: vi.fn(async () => ({
      uid, schema: rootSchemaUid(), time: 1n, expirationTime: 0n, revocationTime: 0n, refUID: ZERO32,
      recipient: '0x0000000000000000000000000000000000000000', attester: WATCHER, revocable: false,
      data: encodeRoot({ root: m.root, night: 20261106, count: 3, agentId: 7n, manifestURI: `https://x.test/api/v1/manifest/${m.hash}` }),
    })),
  } as unknown as AnyPublicClient;
  return { bundles, m, uid, client };
}

describe('verifyInBrowser, nightly root', () => {
  it('runs the root checks from the row fields and says how the proof reaches the root, in which tx', async () => {
    const { bundles, m, uid, client } = setup();
    const b = bundles[1];
    const text = canonicalize(b);
    const leaf = m.inOrder[1].leaf;
    const out = await verifyInBrowser({
      hash: hashEvidence(b), evidence: text, uid, observed: true, watcher: WATCHER,
      status: 'unavailable', lit30: 0, proof: m.proofs.get(leaf)!, tx: TX, client,
    });
    expect(out.match).toBe(true);
    expect(out.checks.map((c) => c.key)).toEqual(['rehash', 'exists', 'schema', 'attester', 'notRevoked', 'notExpired', 'night', 'proof', 'hash']);
    expect(out.checks.every((c) => c.state === 'pass')).toBe(true);
    expect(out.checks.find((c) => c.key === 'schema')?.label).toBe('It uses the Lights On nightly root schema');
    const steps = m.proofs.get(leaf)!.length;
    expect(out.proofLine).toBe(`Merkle proof · ${steps} step${steps === 1 ? '' : 's'} → root ${m.root.slice(0, 10)}…${m.root.slice(-6)} attested in tx ${TX.slice(0, 10)}…${TX.slice(-6)}`);
    expect(out.summary).toContain('one of the 3 project-nights');
  });

  it('a row status the leaf does not commit to fails the proof; a night without a proof cannot match', async () => {
    const { bundles, m, uid, client } = setup();
    const b = bundles[0];
    const base = { hash: hashEvidence(b), evidence: canonicalize(b), uid, observed: true, watcher: WATCHER, lit30: 0, tx: TX, client };
    const lie = await verifyInBrowser({ ...base, status: 'shipped', proof: m.proofs.get(m.inOrder[0].leaf)! });
    expect(lie.match).toBe(false);
    expect(lie.checks.find((c) => c.key === 'proof')?.state).toBe('fail');
    expect(lie.proofLine).toBeNull();
    const none = await verifyInBrowser({ ...base, status: 'unavailable', proof: null });
    expect(none.match).toBe(false);
    expect(none.summary).toMatch(/no Merkle proof/);
  });
});
