import type { Address, Hex, PublicClient } from 'viem';
import { hashEvidence } from '@/lib/shift/evidence';
import type { EvidenceBundle } from '@/lib/types';
import { EAS_ADDRESS, easAbi } from './abi';
import { decodeNight } from './eas';

export async function verifyNight(
  uid: Hex, bundle: EvidenceBundle, client: PublicClient,
): Promise<{ match: boolean; onchainHash: Hex; localHash: Hex; attester: Address }> {
  const a = await client.readContract({ address: EAS_ADDRESS, abi: easAbi, functionName: 'getAttestation', args: [uid] });
  if (a.uid === '0x' + '00'.repeat(32)) throw new Error('attestation_not_found');
  const onchainHash = decodeNight(a.data).evidenceHash;
  const localHash = hashEvidence(bundle);
  return { match: onchainHash.toLowerCase() === localHash.toLowerCase(), onchainHash, localHash, attester: a.attester };
}
