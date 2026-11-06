import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { hashEvidence } from '@/lib/shift/evidence';
import { STATUS_CODE, type EvidenceBundle, type Status } from '@/lib/types';
import { EAS_ADDRESS, easAbi } from './abi';
import { decodeNight, decodeRoot, rootSchemaUid, schemaUid } from './eas';
import { nightLeaf } from './manifest';
import { verifyProof } from './merkle';
import type { AnyPublicClient } from './signer';

interface CommonChecks {
  exists: boolean; schema: boolean; attester: boolean; notRevoked: boolean; notExpired: boolean; night: boolean; hash: boolean;
}
/** Per-project attestation (live runs): project, night and evidence hash are fields of the attestation itself. */
export interface SingleChecks extends CommonChecks { project: boolean }
/**
 * Nightly root attestation: `proof` = the leaf rebuilt from this bundle (project, night) and the row (status, lit30)
 * reaches the attested root; `hash` = the evidence hash inside that proven leaf equals the re-hashed bundle.
 */
export interface RootChecks extends CommonChecks { proof: boolean }
export type VerifyChecks = SingleChecks | RootChecks;

/** What a nightly row says about itself (REST / page data). Untrusted: it only matches if it proves into the root. */
export interface RootRow {
  status: Status;
  /** The lit30 the leaf commits to (attestLit30): an integer in 0..65535, anything else fails. */
  lit30: number;
  proof: readonly Hex[] | readonly string[];
  /** The row's evidence hash; defaults to the bundle's. Lets a mismatch say "this bundle is not that row's evidence". */
  evidenceHash?: Hex | string | null;
}

interface Base { match: boolean; localHash: Hex; attester: Address; onchainHash: Hex }
export type VerifyResult =
  | (Base & { mode: 'single'; checks: SingleChecks })
  | (Base & {
      mode: 'root'; checks: RootChecks;
      /** From the attestation, when it decodes: the root, how many project-nights it covers, the manifest URI. */
      root?: Hex; count?: number; manifestURI?: string;
      /** The leaf rebuilt locally, and how many proof steps lead from it to the root. */
      leaf?: Hex; proofSteps?: number;
    });

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (h: string) => h.toLowerCase();

/**
 * Authenticated check of one night against Base. Common to both modes: the attestation exists, was made by an
 * allowlisted attester, is neither revoked nor expired, and its night equals the bundle's.
 *   - nightly ROOT schema: the leaf keccak256(abi.encode(projectKey(bundle.project), bundle.night, 0, row.status,
 *     row.lit30, evidenceHash)) must reach the attested root through row.proof, and that evidenceHash must equal the
 *     re-hashed bundle. Without `opts.row` a root attestation never matches.
 *   - per-project schema (live runs): project, night and evidence hash are compared field by field.
 * Never throws: anything unreadable or malformed is a failed check.
 */
export async function verifyNight(
  uid: Hex, bundle: EvidenceBundle, client: AnyPublicClient, expectedAttesters: Address[], opts: { row?: RootRow } = {},
): Promise<VerifyResult> {
  const localHash = hashEvidence(bundle);
  const common: CommonChecks = { exists: false, schema: false, attester: false, notRevoked: false, notExpired: false, night: false, hash: false };
  let attester: Address = ZERO_ADDR;
  let a: { uid: Hex; schema: Hex; attester: Address; revocationTime: bigint; expirationTime: bigint; data: Hex } | null = null;
  try {
    a = await client.readContract({ address: EAS_ADDRESS, abi: easAbi, functionName: 'getAttestation', args: [uid] });
  } catch { /* unreadable attestation: everything false */ }
  const isRoot = a ? lc(a.schema) === lc(rootSchemaUid()) : !!opts.row;
  if (a) {
    attester = a.attester;
    common.exists = uid !== ZERO32 && a.uid !== ZERO32 && lc(a.uid) === lc(uid);
    common.schema = isRoot || lc(a.schema) === lc(schemaUid());
    common.attester = expectedAttesters.some((x) => lc(x) === lc(a!.attester));
    common.notRevoked = a.revocationTime === 0n;
    common.notExpired = a.expirationTime === 0n;
  }

  if (!isRoot) {
    const checks: SingleChecks = { ...common, project: false };
    let onchainHash: Hex = ZERO32;
    if (a) {
      try {
        const d = decodeNight(a.data);
        onchainHash = d.evidenceHash;
        checks.project = lc(d.projectKey) === lc(keccak256(toBytes(bundle.project)));
        checks.night = d.night === bundle.night;
        checks.hash = lc(d.evidenceHash) === lc(localHash);
      } catch { /* malformed data: project/night/hash stay false */ }
    }
    return { mode: 'single', match: Object.values(checks).every(Boolean), checks, onchainHash, localHash, attester };
  }

  const checks: RootChecks = { ...common, proof: false };
  let onchainHash: Hex = ZERO32;
  const out: { root?: Hex; count?: number; manifestURI?: string; leaf?: Hex; proofSteps?: number } = {};
  try {
    const d = a ? decodeRoot(a.data) : null;
    if (d) {
      out.root = d.root;
      out.count = d.count;
      out.manifestURI = d.manifestURI;
      checks.night = d.night === bundle.night;
    }
    const row = opts.row;
    const code = row ? STATUS_CODE[row.status] : undefined;
    const leafHash = (row?.evidenceHash ?? localHash) as Hex;
    // lit30 must already be a uint16: clamping an out-of-range value could turn it into the committed one
    const lit30Ok = !!row && Number.isInteger(row.lit30) && row.lit30 >= 0 && row.lit30 <= 65_535;
    if (row && code && lit30Ok && HEX32.test(leafHash) && Array.isArray(row.proof)) {
      const leaf = nightLeaf({
        projectKey: keccak256(toBytes(bundle.project)), night: bundle.night, status: code, lit30: row.lit30, evidenceHash: leafHash,
      });
      out.leaf = leaf;
      out.proofSteps = row.proof.length;
      checks.proof = !!d && verifyProof(leaf, row.proof as Hex[], d.root);
      if (checks.proof) onchainHash = lc(leafHash) as Hex;
      checks.hash = checks.proof && lc(leafHash) === lc(localHash);
    }
  } catch { /* malformed data or row: night/proof/hash stay false */ }
  return { mode: 'root', match: Object.values(checks).every(Boolean), checks, onchainHash, localHash, attester, ...out };
}
