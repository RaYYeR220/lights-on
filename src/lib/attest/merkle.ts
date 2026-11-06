import { concat, keccak256, type Hex } from 'viem';

/**
 * The Merkle tree behind a nightly root attestation. Leaves are sorted ascending (by their 32-byte value) before the
 * tree is built; a parent is keccak256 of its two children concatenated in ascending order (sorted-pair hashing, so a
 * proof needs no left/right flags); a node without a sibling on its level is promoted unchanged. One leaf: the root
 * is the leaf and its proof is empty. Not OpenZeppelin StandardMerkleTree (no double hashing): the leaf preimage is
 * 192 bytes of abi.encode, an inner node's 64, so the two can never be confused.
 */

const WORD = /^0x[0-9a-fA-F]{64}$/;
const lc = (h: string) => h.toLowerCase() as Hex;

export function hashPair(a: Hex, b: Hex): Hex {
  const x = lc(a);
  const y = lc(b);
  return keccak256(concat(x <= y ? [x, y] : [y, x]));
}

/** Root and every leaf's proof (keys are the lowercase leaves). Throws on empty input, duplicates, or a non-32-byte leaf. */
export function buildTree(leaves: Hex[]): { root: Hex; proofs: Map<Hex, Hex[]> } {
  if (leaves.length === 0) throw new Error('merkle: no leaves');
  const level0 = leaves.map((l) => {
    if (typeof l !== 'string' || !WORD.test(l)) throw new Error('merkle: a leaf is not 32 bytes');
    return lc(l);
  }).sort();
  for (let i = 1; i < level0.length; i++) if (level0[i] === level0[i - 1]) throw new Error('merkle: duplicate leaf');

  const proofs = new Map<Hex, Hex[]>(level0.map((l) => [l, []]));
  // members[i] = the leaves under node i of the current level
  let nodes = level0;
  let members: Hex[][] = level0.map((l) => [l]);
  while (nodes.length > 1) {
    const next: Hex[] = [];
    const nextMembers: Hex[][] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 === nodes.length) { // odd node: promoted, no proof step
        next.push(nodes[i]);
        nextMembers.push(members[i]);
        continue;
      }
      for (const l of members[i]) proofs.get(l)!.push(nodes[i + 1]);
      for (const l of members[i + 1]) proofs.get(l)!.push(nodes[i]);
      next.push(hashPair(nodes[i], nodes[i + 1]));
      nextMembers.push([...members[i], ...members[i + 1]]);
    }
    nodes = next;
    members = nextMembers;
  }
  return { root: nodes[0], proofs };
}

/** True iff folding `proof` into `leaf` with sorted-pair hashing gives `root`. Never throws (junk input is false). */
export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  if (typeof leaf !== 'string' || !WORD.test(leaf) || typeof root !== 'string' || !WORD.test(root) || !Array.isArray(proof)) return false;
  let h = lc(leaf);
  for (const p of proof) {
    if (typeof p !== 'string' || !WORD.test(p)) return false;
    h = hashPair(h, p);
  }
  return h === lc(root);
}
