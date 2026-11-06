import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { hashEvidence } from '@/lib/shift/evidence';
import type { EvidenceBundle } from '@/lib/types';
import { EAS_ADDRESS, easAbi } from './abi';
import { decodeNight, schemaUid } from './eas';
import type { AnyPublicClient } from './signer';

export interface VerifyChecks {
  exists: boolean; schema: boolean; attester: boolean; notRevoked: boolean; notExpired: boolean;
  project: boolean; night: boolean; hash: boolean;
}

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Authenticated check: match is true only if the attestation exists, uses our schema, was made by an allowlisted
 * attester, is neither revoked nor expired, and its project/night/evidenceHash all equal the bundle's.
 */
export async function verifyNight(
  uid: Hex, bundle: EvidenceBundle, client: AnyPublicClient, expectedAttesters: Address[],
): Promise<{ match: boolean; checks: VerifyChecks; onchainHash: Hex; localHash: Hex; attester: Address }> {
  const localHash = hashEvidence(bundle);
  const checks: VerifyChecks = {
    exists: false, schema: false, attester: false, notRevoked: false, notExpired: false, project: false, night: false, hash: false,
  };
  let onchainHash: Hex = ZERO32;
  let attester: Address = ZERO_ADDR;
  try {
    const a = await client.readContract({ address: EAS_ADDRESS, abi: easAbi, functionName: 'getAttestation', args: [uid] });
    attester = a.attester;
    checks.exists = uid !== ZERO32 && a.uid !== ZERO32 && a.uid.toLowerCase() === uid.toLowerCase();
    checks.schema = a.schema.toLowerCase() === schemaUid().toLowerCase();
    checks.attester = expectedAttesters.some((x) => x.toLowerCase() === a.attester.toLowerCase());
    checks.notRevoked = a.revocationTime === 0n;
    checks.notExpired = a.expirationTime === 0n;
    try {
      const d = decodeNight(a.data);
      onchainHash = d.evidenceHash;
      checks.project = d.projectKey.toLowerCase() === keccak256(toBytes(bundle.project)).toLowerCase();
      checks.night = d.night === bundle.night;
      checks.hash = d.evidenceHash.toLowerCase() === localHash.toLowerCase();
    } catch { /* malformed data: project/night/hash stay false */ }
  } catch { /* unreadable attestation: everything false */ }
  const match = Object.values(checks).every(Boolean);
  return { match, checks, onchainHash, localHash, attester };
}
