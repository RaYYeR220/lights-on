import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import { attestMany, attestOne, decodeNight, encodeNight, schemaUid, SCHEMA, type AttestDeps, type NightAttestation } from '@/lib/attest/eas';

const night = (i = 0): NightAttestation => ({
  projectKey: keccak256(toBytes(`proj-${i}`)), night: 20261106, kind: 0, status: 1, lit30: 17,
  evidenceHash: keccak256(toBytes(`ev-${i}`)), agentId: 42n, evidenceURI: 'https://example.test/api/v1/evidence/0xabc',
});

function deps(over: { budget?: (w: bigint) => Promise<boolean>; wallet?: null; estimateErr?: Error } = {}) {
  const writeContract = vi.fn(async () => ('0x' + '11'.repeat(32)) as Hex);
  const publicClient = {
    estimateContractGas: vi.fn(async () => {
      if (over.estimateErr) throw over.estimateErr;
      return 200_000n;
    }),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 3_000_000n, maxPriorityFeePerGas: 1n })),
    waitForTransactionReceipt: vi.fn(),
  };
  const wallet = over.wallet === null ? null : ({ account: { address: zeroAddress }, chain: undefined, writeContract } as never);
  const budget = vi.fn(over.budget ?? (async () => true));
  return { d: { wallet, publicClient, budget } as unknown as AttestDeps, writeContract, publicClient, budget };
}

describe('eas encoding', () => {
  it('encode/decode round trip', () => {
    const n = night();
    expect(decodeNight(encodeNight(n))).toEqual(n);
    const live: NightAttestation = { ...n, kind: 1, status: 5, agentId: 2n ** 200n, evidenceURI: '' };
    expect(decodeNight(encodeNight(live))).toEqual(live);
  });

  it('schemaUid is the keccak of schema, resolver, revocable', () => {
    expect(SCHEMA).toBe('bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI');
    expect(schemaUid()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(schemaUid()).not.toBe(schemaUid(zeroAddress, true));
  });
});

describe('attest gas cap', () => {
  it('over the cap: skipped gas_cap and NO tx sent', async () => {
    const { d, writeContract, budget } = deps({ budget: async () => false });
    expect(await attestOne(night(), d)).toEqual({ skipped: 'gas_cap' });
    expect(await attestMany([night(1), night(2)], d)).toEqual({ skipped: 'gas_cap' });
    expect(writeContract).not.toHaveBeenCalled();
    expect(budget).toHaveBeenCalledWith(200_000n * 3_000_000n);
  });

  it('no signer: skipped disabled, nothing estimated', async () => {
    const { d, publicClient } = deps({ wallet: null });
    expect(await attestOne(night(), d)).toEqual({ skipped: 'disabled' });
    expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
  });

  it('estimate failure: skipped error with a redacted code, never throws', async () => {
    const { d, writeContract } = deps({ estimateErr: new Error('boom https://rpc.example/?key=SECRET') });
    const r = await attestMany([night()], d);
    expect(r).toEqual({ skipped: 'error', error: 'error' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('empty batch is not sent', async () => {
    const { d, writeContract } = deps();
    expect(await attestMany([], d)).toMatchObject({ skipped: 'error' });
    expect(writeContract).not.toHaveBeenCalled();
  });
});
