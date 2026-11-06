import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, type Hex } from 'viem';
import { canonicalize } from '@/lib/shift/evidence';
import { STATUS_CODE, type Status } from '@/lib/types';
import { buildTree } from './merkle';

/**
 * One nightly root attestation commits to every project-night of its batch through a Merkle root. The leaf of a
 * project-night is keccak256(abi.encode(bytes32 projectKey, uint32 night, uint8 kind = 0, uint8 status, uint16 lit30,
 * bytes32 evidenceHash)): the same fields the per-project schema carries, minus agentId and the URI (the root
 * attestation carries those once). The manifest lists every leaf with its plain fields, as canonical JSON; its
 * keccak256 is the hash in the attestation's manifestURI.
 */

const LEAF_PARAMS = parseAbiParameters('bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash');

export const MANIFEST_SCHEMA = 'lights-on/night-manifest';

export function nightLeaf(p: { projectKey: Hex; night: number; status: 1 | 2 | 3 | 4 | 5; lit30: number; evidenceHash: Hex }): Hex {
  return keccak256(encodeAbiParameters(LEAF_PARAMS, [p.projectKey, p.night, 0, p.status, p.lit30, p.evidenceHash]));
}

/** lit30 as the uint16 field stores it. */
export const clampLit30 = (n: number) => Math.min(Math.max(0, Math.trunc(n)), 65_535);

export interface ManifestEntry { slug: string; night: number; status: Status; lit30: number; evidenceHash: Hex }

export interface ManifestLeaf {
  slug: string; projectKey: Hex; night: number; kind: 0; status: Status; statusCode: 1 | 2 | 3 | 4 | 5;
  lit30: number; evidenceHash: Hex; leaf: Hex;
}

export interface NightManifest {
  v: 1; schema: typeof MANIFEST_SCHEMA; night: number; count: number;
  /** Sorted ascending by leaf (the order the tree is built in). */
  leaves: ManifestLeaf[];
  root: Hex;
  /** The watcher's ERC-8004 agent id, as a decimal string (JSON has no bigint). */
  agentId: string;
}

export interface BuiltManifest {
  manifest: NightManifest;
  /** canonicalize(manifest): the exact bytes served at /api/v1/manifest/<hash>. */
  body: string;
  hash: Hex;
  root: Hex;
  proofs: Map<Hex, Hex[]>;
  /** The leaves in input order (entries[i] -> inOrder[i]). */
  inOrder: ManifestLeaf[];
}

/** Manifest + tree for one batch of project-nights of the same night. Throws on an empty batch or mixed nights. */
export function buildNightManifest(entries: ManifestEntry[], agentId: bigint): BuiltManifest {
  if (entries.length === 0) throw new Error('manifest: empty batch');
  const night = entries[0].night;
  if (entries.some((e) => e.night !== night)) throw new Error('manifest: mixed nights');
  const inOrder: ManifestLeaf[] = entries.map((e) => {
    const projectKey = keccak256(toBytes(e.slug));
    const statusCode = STATUS_CODE[e.status];
    const lit30 = clampLit30(e.lit30);
    const evidenceHash = e.evidenceHash.toLowerCase() as Hex;
    return {
      slug: e.slug, projectKey, night, kind: 0, status: e.status, statusCode, lit30, evidenceHash,
      leaf: nightLeaf({ projectKey, night, status: statusCode, lit30, evidenceHash }),
    };
  });
  const { root, proofs } = buildTree(inOrder.map((l) => l.leaf));
  const manifest: NightManifest = {
    v: 1, schema: MANIFEST_SCHEMA, night, count: inOrder.length,
    leaves: [...inOrder].sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0)),
    root, agentId: agentId.toString(),
  };
  const body = canonicalize(manifest);
  return { manifest, body, hash: keccak256(toBytes(body)), root, proofs, inOrder };
}
