import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';
import { buildNightManifest, nightLeaf, type ManifestEntry } from '@/lib/attest/manifest';
import { verifyProof } from '@/lib/attest/merkle';
import { canonicalize } from '@/lib/shift/evidence';

const ev = (i: number) => keccak256(toBytes(`ev-${i}`));
const entry = (i: number, o: Partial<ManifestEntry> = {}): ManifestEntry => ({
  slug: `proj-${i}`, night: 20261106, status: 'shipped', lit30: i, evidenceHash: ev(i), ...o,
});

describe('night leaf', () => {
  it('is keccak256(abi.encode(projectKey, night, kind 0, status, lit30, evidenceHash))', () => {
    const projectKey = keccak256(toBytes('revoke-cash'));
    const want = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'bytes32' }],
      [projectKey, 20261106, 0, 2, 17, ev(1)],
    ));
    expect(nightLeaf({ projectKey, night: 20261106, status: 2, lit30: 17, evidenceHash: ev(1) })).toBe(want);
    // any field changes the leaf
    const base = { projectKey, night: 20261106, status: 2 as const, lit30: 17, evidenceHash: ev(1) };
    for (const o of [{ night: 20261105 }, { status: 3 as const }, { lit30: 16 }, { evidenceHash: ev(2) }, { projectKey: keccak256(toBytes('x')) }]) {
      expect(nightLeaf({ ...base, ...o })).not.toBe(want);
    }
  });
});

describe('night manifest', () => {
  it('canonical JSON with the agreed shape; leaves sorted by leaf; hash = keccak256 of the body', () => {
    const m = buildNightManifest([entry(1), entry(2, { status: 'quiet' }), entry(3, { status: 'unavailable' })], 7n);
    expect(m.body).toBe(canonicalize(m.manifest));
    expect(m.hash).toBe(keccak256(toBytes(m.body)));
    expect(m.manifest).toMatchObject({ v: 1, schema: 'lights-on/night-manifest', night: 20261106, count: 3, agentId: '7', root: m.root });
    const ls = m.manifest.leaves;
    expect(ls.map((l) => l.leaf)).toEqual([...ls.map((l) => l.leaf)].sort());
    const q = ls.find((l) => l.slug === 'proj-2')!;
    expect(q).toEqual({
      slug: 'proj-2', projectKey: keccak256(toBytes('proj-2')), night: 20261106, kind: 0, status: 'quiet', statusCode: 3, lit30: 2,
      evidenceHash: ev(2), leaf: nightLeaf({ projectKey: keccak256(toBytes('proj-2')), night: 20261106, status: 3, lit30: 2, evidenceHash: ev(2) }),
    });
    for (const l of ls) expect(verifyProof(l.leaf as Hex, m.proofs.get(l.leaf as Hex)!, m.root)).toBe(true);
  });

  it('is stable: the same nights in any order give the same bytes and hash', () => {
    const a = buildNightManifest([entry(1), entry(2), entry(3)], 7n);
    const b = buildNightManifest([entry(3), entry(1), entry(2)], 7n);
    expect(b.body).toBe(a.body);
    expect(b.hash).toBe(a.hash);
    expect(b.root).toBe(a.root);
    // and survives a JSON round trip (what jsonb storage does) byte for byte
    expect(canonicalize(JSON.parse(a.body))).toBe(a.body);
    expect(buildNightManifest([entry(1), entry(2), entry(3)], 8n).hash).not.toBe(a.hash); // agentId is part of it
  });

  it('lit30 is clamped like the attestation field; mixed nights and empty batches are refused', () => {
    const m = buildNightManifest([entry(1, { lit30: 70_000 }), entry(2, { lit30: -3 })], 7n);
    expect(m.manifest.leaves.map((l) => l.lit30).sort((x, y) => x - y)).toEqual([0, 65_535]);
    expect(() => buildNightManifest([entry(1), entry(2, { night: 20261105 })], 7n)).toThrow();
    expect(() => buildNightManifest([], 7n)).toThrow();
  });
});
