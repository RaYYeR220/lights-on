import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import { attestMany, attestOne, computeFees, decodeNight, encodeNight, schemaUid, SCHEMA, type AttestDeps, type NightAttestation } from '@/lib/attest/eas';

const night = (i = 0): NightAttestation => ({
  projectKey: keccak256(toBytes(`proj-${i}`)), night: 20261106, kind: 0, status: 1, lit30: 17,
  evidenceHash: keccak256(toBytes(`ev-${i}`)), agentId: 42n, evidenceURI: 'https://example.test/api/v1/evidence/0xabc',
});

function deps(over: { budget?: (w: bigint) => Promise<boolean>; wallet?: null; estimateErr?: Error; baseFee?: bigint; tip?: bigint; writeErr?: Error } = {}) {
  const writeContract = vi.fn(async (_a?: unknown) => {
    if (over.writeErr) throw over.writeErr;
    return ('0x' + '11'.repeat(32)) as Hex;
  });
  const publicClient = {
    estimateContractGas: vi.fn(async () => {
      if (over.estimateErr) throw over.estimateErr;
      return 200_000n;
    }),
    getBlock: vi.fn(async () => ({ baseFeePerGas: over.baseFee ?? 1_000_000n })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => over.tip ?? 1_000_000n),
    waitForTransactionReceipt: vi.fn(),
  };
  const wallet = over.wallet === null ? null : ({ account: { address: zeroAddress }, chain: undefined, writeContract } as never);
  const budget = vi.fn(over.budget ?? (async () => true));
  const release = vi.fn(async (_w: bigint) => undefined);
  return { d: { wallet, publicClient, budget, release } as unknown as AttestDeps, writeContract, publicClient, budget, release };
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
    expect(budget).toHaveBeenCalledWith(240_000n * (2n * 1_000_000n + 1_000_000n)); // 1.2x gas, 2x baseFee + tip
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

describe('explicit fees', () => {
  it('clamps an RPC tip of 1 gwei down to 0.01 gwei and floors tiny tips', () => {
    expect(computeFees(5_000_000n, 1_000_000_000n)).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 20_000_000n });
    expect(computeFees(5_000_000n, 1n).maxPriorityFeePerGas).toBe(1_000_000n);
  });

  it('passes gas x1.2 and both fee fields to writeContract; tip clamped', async () => {
    const { d, writeContract } = deps({ baseFee: 5_000_000n, tip: 1_000_000_000n });
    await attestOne(night(), d); // receipt wait is unmocked -> error after broadcast, fine
    const arg = writeContract.mock.calls[0]![0] as { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    expect(arg.gas).toBe(240_000n);
    expect(arg.maxPriorityFeePerGas).toBe(10_000_000n);
    expect(arg.maxFeePerGas).toBe(20_000_000n);
  });

  it('60 attestations at realistic Base fees (baseFee 0.005 gwei, ~350k gas each) reserve under 0.0004 ETH', async () => {
    const { d, budget } = deps({ baseFee: 5_000_000n, tip: 1_000_000n }); // typical Base tip ~0.001 gwei
    d.publicClient.estimateContractGas = (async () => 60n * 350_000n) as never;
    await attestMany(Array.from({ length: 60 }, (_, i) => night(i)), d);
    const reserved = budget.mock.calls[0]![0];
    expect(reserved).toBeLessThan(400_000_000_000_000n); // 0.0004 ETH
    expect(reserved).toBeGreaterThan(0n);
  });

  it('releases the reservation only when the tx was never broadcast', async () => {
    const a = deps({ writeErr: new Error('sign failed') });
    expect(await attestOne(night(), a.d)).toMatchObject({ skipped: 'error' });
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(a.release).toHaveBeenCalledWith(240_000n * 3_000_000n);
    const b = deps({ estimateErr: new Error('x') });
    await attestOne(night(), b.d);
    expect(b.release).not.toHaveBeenCalled();
    const c = deps({ budget: async () => false });
    await attestOne(night(), c.d);
    expect(c.release).not.toHaveBeenCalled();
  });
});
