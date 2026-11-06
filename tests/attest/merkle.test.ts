import { describe, expect, it } from 'vitest';
import { concat, keccak256, toBytes, type Hex } from 'viem';
import { buildTree, hashPair, verifyProof } from '@/lib/attest/merkle';

const leaf = (i: number) => keccak256(toBytes(`leaf-${i}`));
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));
const sorted = (xs: Hex[]) => [...xs].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

describe('merkle tree (sorted pairs, sorted leaves, odd node promoted)', () => {
  it('a single leaf is its own root, with an empty proof', () => {
    const t = buildTree([leaf(1)]);
    expect(t.root).toBe(leaf(1));
    expect(t.proofs.get(leaf(1))).toEqual([]);
    expect(verifyProof(leaf(1), [], t.root)).toBe(true);
  });

  it('two leaves: root = keccak(lower || higher), each proof is the other leaf', () => {
    const [a, b] = sorted([leaf(1), leaf(2)]);
    const t = buildTree([b, a]);
    expect(t.root).toBe(keccak256(concat([a, b])));
    expect(t.proofs.get(a)).toEqual([b]);
    expect(t.proofs.get(b)).toEqual([a]);
    expect(hashPair(b, a)).toBe(hashPair(a, b));
  });

  it('three leaves: the odd one is promoted (no proof step on that level)', () => {
    const [a, b, c] = sorted(leaves(3));
    const t = buildTree([c, a, b]);
    expect(t.root).toBe(hashPair(hashPair(a, b), c));
    expect(t.proofs.get(c)).toEqual([hashPair(a, b)]);
    expect(t.proofs.get(a)).toEqual([b, c]);
  });

  it.each([1, 2, 3, 7, 52])('%i leaves: every proof verifies, and only against this root', (n) => {
    const xs = leaves(n);
    const t = buildTree(xs);
    expect(t.proofs.size).toBe(n);
    for (const l of xs) {
      const p = t.proofs.get(l)!;
      expect(p.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
      expect(verifyProof(l, p, t.root)).toBe(true);
      expect(verifyProof(l, p, buildTree([...xs, leaf(999)]).root)).toBe(false);
    }
  });

  it('a tampered leaf or a tampered proof step fails', () => {
    const xs = leaves(7);
    const t = buildTree(xs);
    const p = t.proofs.get(xs[3])!;
    expect(verifyProof(leaf(100), p, t.root)).toBe(false);
    const bad = [...p];
    bad[1] = leaf(101);
    expect(verifyProof(xs[3], bad, t.root)).toBe(false);
    expect(verifyProof(xs[3], p.slice(1), t.root)).toBe(false); // a dropped step
    expect(verifyProof(xs[3], [...p, leaf(102)], t.root)).toBe(false); // an extra step
    expect(verifyProof(xs[3], t.proofs.get(xs[4])!, t.root)).toBe(false); // another leaf's proof
  });

  it('does not depend on input order (or hex case)', () => {
    const xs = leaves(7);
    const a = buildTree(xs);
    const b = buildTree([...xs].reverse());
    const c = buildTree(xs.map((x) => x.toUpperCase().replace('0X', '0x') as Hex));
    expect(b.root).toBe(a.root);
    expect(c.root).toBe(a.root);
    for (const l of xs) expect(b.proofs.get(l)).toEqual(a.proofs.get(l));
  });

  it('refuses empty input, duplicates and non-32-byte leaves; verify never throws on junk', () => {
    expect(() => buildTree([])).toThrow();
    expect(() => buildTree([leaf(1), leaf(1)])).toThrow();
    expect(() => buildTree(['0x1234' as Hex])).toThrow();
    const t = buildTree(leaves(3));
    expect(verifyProof('0xzz' as Hex, [], t.root)).toBe(false);
    expect(verifyProof(leaf(0), ['nope' as Hex], t.root)).toBe(false);
    expect(verifyProof(leaf(0), null as unknown as Hex[], t.root)).toBe(false);
    expect(verifyProof(leaf(0), t.proofs.get(leaf(0))!, '0x' as Hex)).toBe(false);
  });
});
