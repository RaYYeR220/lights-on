import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodePacked, keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import {
  attestOne, attestRoot, attestationStatus, computeFees, decodeNight, decodeRoot, encodeNight, encodeRoot, rootSchemaUid,
  schemaUid, ROOT_SCHEMA, SCHEMA, type AttestDeps, type NightAttestation, type NightRoot,
} from '@/lib/attest/eas';
import { EAS_ADDRESS, easAbi } from '@/lib/attest/abi';

const night = (i = 0): NightAttestation => ({
  projectKey: keccak256(toBytes(`proj-${i}`)), night: 20261106, kind: 0, status: 1, lit30: 17,
  evidenceHash: keccak256(toBytes(`ev-${i}`)), agentId: 42n, evidenceURI: 'https://example.test/api/v1/evidence/0xabc',
});

/** A nightly root over many project-nights (one attestation, whatever the count). */
const R: NightRoot = {
  root: keccak256(toBytes('root')), night: 20261106, count: 52, agentId: 42n,
  manifestURI: `https://example.test/api/v1/manifest/${keccak256(toBytes('m'))}`,
};

/** What the fake wallet "signs"; the tx hash is keccak256 of it, computed locally before anything is sent. */
const SERIALIZED = ('0x02' + 'ab'.repeat(100)) as Hex;
const SENT = keccak256(SERIALIZED);

function deps(over: {
  budget?: (w: bigint) => Promise<boolean>; wallet?: null; estimateErr?: Error; baseFee?: bigint; tip?: bigint;
  signErr?: Error; sendErr?: Error;
} = {}) {
  const signTransaction = vi.fn(async (_a?: unknown) => {
    if (over.signErr) throw over.signErr;
    return SERIALIZED;
  });
  const sendRawTransaction = vi.fn(async () => {
    if (over.sendErr) throw over.sendErr;
    return SENT;
  });
  const publicClient = {
    estimateContractGas: vi.fn(async () => {
      if (over.estimateErr) throw over.estimateErr;
      return 200_000n;
    }),
    getBlock: vi.fn(async () => ({ baseFeePerGas: over.baseFee ?? 1_000_000n })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => over.tip ?? 1_000_000n),
    getTransactionCount: vi.fn(async () => 7),
    waitForTransactionReceipt: vi.fn(),
  };
  const wallet = over.wallet === null ? null : ({ account: { address: zeroAddress }, chain: undefined, signTransaction, sendRawTransaction } as never);
  const budget = vi.fn(over.budget ?? (async () => true));
  const release = vi.fn(async (_w: bigint) => undefined);
  const onBroadcast = vi.fn<(h: Hex, n: number, s: string) => Promise<void>>(async () => undefined); // production callers always persist
  return {
    d: { wallet, publicClient, budget, release, onBroadcast } as unknown as AttestDeps,
    signTransaction, sendRawTransaction, publicClient, budget, release, onBroadcast,
  };
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
  it('over the cap: skipped gas_cap and NO tx signed or sent', async () => {
    const { d, signTransaction, sendRawTransaction, budget } = deps({ budget: async () => false });
    expect(await attestOne(night(), d)).toEqual({ skipped: 'gas_cap' });
    expect(await attestRoot(R, d)).toEqual({ skipped: 'gas_cap' });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(budget).toHaveBeenCalledWith(240_000n * (2n * 1_000_000n + 1_000_000n)); // 1.2x gas, 2x baseFee + tip
  });

  it('no signer: skipped disabled, nothing estimated', async () => {
    const { d, publicClient } = deps({ wallet: null });
    expect(await attestOne(night(), d)).toEqual({ skipped: 'disabled' });
    expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
  });

  it('estimate failure: skipped error with a redacted code, never throws', async () => {
    const { d, sendRawTransaction } = deps({ estimateErr: new Error('boom https://rpc.example/?key=SECRET') });
    const r = await attestRoot(R, d);
    expect(r).toEqual({ skipped: 'error', error: 'error' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('no onBroadcast (and no unsafeNoPersist) -> refused: nothing estimated, reserved, signed or sent', async () => {
    const { d, publicClient, budget, signTransaction, sendRawTransaction } = deps();
    const bare = { ...d, onBroadcast: undefined };
    expect(await attestOne(night(), bare)).toEqual({ skipped: 'error', error: 'no_persist' });
    expect(await attestRoot(R, bare)).toEqual({ skipped: 'error', error: 'no_persist' });
    expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('unsafeNoPersist (fork tests only) sends without a persist', async () => {
    const { d, publicClient, sendRawTransaction } = deps();
    publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: SENT, logs: [] });
    await attestOne(night(), { ...d, onBroadcast: undefined, unsafeNoPersist: true });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

});

describe('explicit fees, local signing', () => {
  it('clamps an RPC tip of 1 gwei down to 0.01 gwei and floors tiny tips', () => {
    expect(computeFees(5_000_000n, 1_000_000_000n)).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 20_000_000n });
    expect(computeFees(5_000_000n, 1n).maxPriorityFeePerGas).toBe(1_000_000n);
  });

  it('signs an EIP-1559 tx to EAS with gas x1.2, both fee fields, the pending nonce and attest calldata', async () => {
    const { d, signTransaction, sendRawTransaction } = deps({ baseFee: 5_000_000n, tip: 1_000_000_000n });
    await attestOne(night(), d); // receipt wait is unmocked -> error after the send, fine
    const arg = signTransaction.mock.calls[0]![0] as {
      to: string; data: Hex; type: string; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number; value: bigint;
    };
    expect(arg).toMatchObject({ to: EAS_ADDRESS, type: 'eip1559', gas: 240_000n, nonce: 7, value: 0n, maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 20_000_000n });
    expect(decodeFunctionData({ abi: easAbi, data: arg.data }).functionName).toBe('attest');
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: SERIALIZED });
  });

  it('refunds the reservation only when nothing was sent', async () => {
    const a = deps({ signErr: new Error('sign failed') });
    expect(await attestOne(night(), a.d)).toMatchObject({ skipped: 'error' });
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(a.release).toHaveBeenCalledWith(240_000n * 3_000_000n);
    expect(a.sendRawTransaction).not.toHaveBeenCalled();
    const b = deps({ estimateErr: new Error('x') });
    await attestOne(night(), b.d);
    expect(b.release).not.toHaveBeenCalled();
    const c = deps({ budget: async () => false });
    await attestOne(night(), c.d);
    expect(c.release).not.toHaveBeenCalled();
  });
});

const attestedLog = (uid: Hex, address: string = EAS_ADDRESS) => ({
  address,
  topics: encodeEventTopics({ abi: easAbi, eventName: 'Attested', args: { recipient: zeroAddress, attester: zeroAddress, schemaUID: schemaUid() } }),
  data: encodeAbiParameters([{ type: 'bytes32' }], [uid]),
});
const uid = (i: number) => keccak256(toBytes(`uid-${i}`));
const mined = (logs: unknown[], status = 'success', transactionHash: Hex = SENT) => ({ status, transactionHash, logs });

describe('persist before send; after that the tx hash is never lost', () => {
  it('the hash (keccak of the signed tx), nonce and sender are persisted BEFORE the raw tx is sent', async () => {
    const { d, publicClient, sendRawTransaction } = deps();
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([attestedLog(uid(1))]));
    const persisted: [Hex, number, string][] = [];
    const onBroadcast = vi.fn(async (h: Hex, n: number, s: string) => { persisted.push([h, n, s]); });
    expect(await attestOne(night(), { ...d, onBroadcast })).toEqual({ uid: uid(1), txHash: SENT });
    expect(persisted).toEqual([[SENT, 7, zeroAddress]]);
    expect(onBroadcast.mock.invocationCallOrder[0]).toBeLessThan(sendRawTransaction.mock.invocationCallOrder[0]);
    expect(publicClient.getTransactionCount).toHaveBeenCalledWith({ address: zeroAddress, blockTag: 'pending' });
  });

  it('send throws after the persist (timeout, "already known") -> skipped error WITH txHash + nonce, no refund', async () => {
    const { d, release } = deps({ sendErr: Object.assign(new Error('x'), { name: 'TimeoutError' }) });
    const onBroadcast = vi.fn(async () => undefined);
    expect(await attestRoot(R, { ...d, onBroadcast })).toEqual({ skipped: 'error', error: 'timeout', txHash: SENT, nonce: 7 });
    expect(onBroadcast).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('a failing persist means nothing is sent and the reservation is refunded', async () => {
    const { d, sendRawTransaction, release } = deps();
    const r = await attestOne(night(), { ...d, onBroadcast: async () => { throw new Error('db down'); } });
    expect(r).toEqual({ skipped: 'error', error: 'persist_failed' });
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('receipt wait fails -> skipped error WITH txHash + nonce; configurable wait', async () => {
    const { d, publicClient, release } = deps();
    publicClient.waitForTransactionReceipt.mockRejectedValue(Object.assign(new Error('x'), { name: 'WaitForTransactionReceiptTimeoutError' }));
    expect(await attestRoot(R, d)).toEqual({ skipped: 'error', error: 'timeout', txHash: SENT, nonce: 7 });
    expect(release).not.toHaveBeenCalled();
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: SENT, timeout: 60_000 });
    await attestOne(night(), { ...d, receiptTimeoutMs: 30_000 });
    expect(publicClient.waitForTransactionReceipt).toHaveBeenLastCalledWith({ hash: SENT, timeout: 30_000 });
  });

  it('a replacement receipt (another tx took our nonce) is never adopted: skipped replaced, no uids', async () => {
    const { d, publicClient } = deps();
    const other = keccak256(toBytes('someone else'));
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([attestedLog(uid(1))], 'success', other));
    const r = await attestRoot(R, d);
    expect(r).toEqual({ skipped: 'error', error: 'replaced', txHash: SENT, nonce: 7 });
    expect('uid' in r).toBe(false);
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([attestedLog(uid(1))], 'success', other.toUpperCase().replace('0X', '0x') as Hex));
    expect(await attestOne(night(), d)).toMatchObject({ error: 'replaced' });
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([attestedLog(uid(1))], 'success', SENT.toUpperCase().replace('0X', '0x') as Hex));
    expect(await attestOne(night(), d)).toEqual({ uid: uid(1), txHash: SENT }); // same hash, other case: ours
  });

  it('reverted receipt -> skipped error reverted WITH txHash', async () => {
    const { d, publicClient } = deps();
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([], 'reverted'));
    expect(await attestOne(night(), d)).toEqual({ skipped: 'error', error: 'reverted', txHash: SENT, nonce: 7 });
    expect(await attestRoot(R, d)).toEqual({ skipped: 'error', error: 'reverted', txHash: SENT, nonce: 7 });
  });
});

describe('nightly root attestation', () => {
  const root = (o: Partial<NightRoot> = {}): NightRoot => ({ ...R, ...o });

  it('schema string, uid, encode/decode round trip', () => {
    expect(ROOT_SCHEMA).toBe('bytes32 root,uint32 night,uint16 count,uint256 agentId,string manifestURI');
    expect(rootSchemaUid()).toBe(keccak256(encodePacked(['string', 'address', 'bool'], [ROOT_SCHEMA, zeroAddress, false])));
    expect(rootSchemaUid()).not.toBe(schemaUid());
    const r = root();
    expect(decodeRoot(encodeRoot(r))).toEqual(r);
  });

  it('one attest call under the root schema, through the same persist-before-send path', async () => {
    const { d, publicClient, signTransaction, sendRawTransaction, onBroadcast } = deps();
    publicClient.waitForTransactionReceipt.mockResolvedValue(mined([attestedLog(uid(1))]));
    expect(await attestRoot(root(), d)).toEqual({ uid: uid(1), txHash: SENT });
    const call = decodeFunctionData({ abi: easAbi, data: (signTransaction.mock.calls[0]![0] as { data: Hex }).data });
    expect(call.functionName).toBe('attest');
    const req = (call.args as unknown as [{ schema: Hex; data: { data: Hex; revocable: boolean; expirationTime: bigint } }])[0];
    expect(req.schema).toBe(rootSchemaUid());
    expect(req.data).toMatchObject({ revocable: false, expirationTime: 0n });
    expect(decodeRoot(req.data.data)).toEqual(root());
    expect(onBroadcast).toHaveBeenCalledWith(SENT, 7, zeroAddress);
    expect(onBroadcast.mock.invocationCallOrder[0]).toBeLessThan(sendRawTransaction.mock.invocationCallOrder[0]);
  });

  it('the uid count check is 1: no Attested log, or two, is an error that keeps the tx hash', async () => {
    for (const logs of [[], [attestedLog(uid(1)), attestedLog(uid(2))]]) {
      const { d, publicClient } = deps();
      publicClient.waitForTransactionReceipt.mockResolvedValue(mined(logs));
      expect(await attestRoot(root(), d)).toEqual({ skipped: 'error', error: 'uid_count_mismatch', txHash: SENT, nonce: 7 });
    }
  });

  it('keeps every guard: no hook -> no_persist, over the cap -> nothing signed, send error after persist -> txHash', async () => {
    const a = deps();
    expect(await attestRoot(root(), { ...a.d, onBroadcast: undefined })).toEqual({ skipped: 'error', error: 'no_persist' });
    expect(a.signTransaction).not.toHaveBeenCalled();
    const b = deps({ budget: async () => false });
    expect(await attestRoot(root(), b.d)).toEqual({ skipped: 'gas_cap' });
    expect(b.signTransaction).not.toHaveBeenCalled();
    const c = deps({ sendErr: Object.assign(new Error('x'), { name: 'TimeoutError' }) });
    expect(await attestRoot(root(), c.d)).toEqual({ skipped: 'error', error: 'timeout', txHash: SENT, nonce: 7 });
    expect(c.release).not.toHaveBeenCalled();
  });

  it('refuses a malformed root before anything is estimated', async () => {
    for (const bad of [root({ count: 0 }), root({ count: 65_536 }), root({ root: '0x1234' as Hex }), root({ night: 0 })]) {
      const { d, publicClient } = deps();
      expect(await attestRoot(bad, d)).toEqual({ skipped: 'error', error: 'invalid_root' });
      expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
    }
  });

  it('any number of project-nights reserves the gas of one attestation', async () => {
    const { d, budget } = deps({ baseFee: 5_000_000n, tip: 1_000_000n });
    d.publicClient.estimateContractGas = (async () => 120_000n) as never;
    await attestRoot(root({ count: 500 }), d);
    expect(budget.mock.calls[0]![0]).toBe(144_000n * 11_000_000n); // 1.2 x 120k gas x (2 x 0.005 + 0.001 gwei)
  });
});

describe('attestationStatus', () => {
  const SENDER = '0x00000000000000000000000000000000000000aa' as const;
  const named = (name: string) => Object.assign(new Error('not found'), { name });
  const nf = () => named('TransactionReceiptNotFoundError');
  const client = (receipt: () => Promise<unknown>, mined = 0, tx: () => Promise<unknown> = async () => { throw named('TransactionNotFoundError'); }) => ({
    getTransactionReceipt: vi.fn(receipt),
    getTransactionCount: vi.fn(async () => mined),
    getTransaction: vi.fn(tx),
  });

  it('mined: uids of the EAS Attested logs in log order, other contracts ignored', async () => {
    const logs = [attestedLog(uid(1)), attestedLog(uid(9), '0x0000000000000000000000000000000000000bad'), attestedLog(uid(2))];
    expect(await attestationStatus(SENT, 4, SENDER, client(async () => ({ status: 'success', logs })) as never))
      .toEqual({ status: 'success', uids: [uid(1), uid(2)] });
  });

  it('reverted', async () => {
    expect(await attestationStatus(SENT, 4, SENDER, client(async () => ({ status: 'reverted', logs: [] })) as never)).toEqual({ status: 'reverted' });
  });

  it('not found and latest nonce <= tx nonce -> pending (may still mine: stays claimed)', async () => {
    for (const m of [3, 4]) {
      const c = client(async () => { throw nf(); }, m);
      expect(await attestationStatus(SENT, 4, SENDER, c as never)).toEqual({ status: 'pending' });
    }
  });

  it('dropped needs: nonce consumed (read before the receipt), no receipt, and the tx unknown to the node', async () => {
    const c = client(async () => { throw nf(); }, 5);
    expect(await attestationStatus(SENT, 4, SENDER, c as never)).toEqual({ status: 'dropped' });
    expect(c.getTransactionCount).toHaveBeenCalledWith({ address: SENDER, blockTag: 'latest' });
    expect(c.getTransactionCount.mock.invocationCallOrder[0]).toBeLessThan(c.getTransactionReceipt.mock.invocationCallOrder[0]);
    expect(c.getTransaction).toHaveBeenCalledWith({ hash: SENT });
  });

  it('nonce consumed but the node still knows the tx (lagging node of a load-balanced RPC) -> pending', async () => {
    const known = client(async () => { throw nf(); }, 5, async () => ({ hash: SENT, blockNumber: null }));
    expect(await attestationStatus(SENT, 4, SENDER, known as never)).toEqual({ status: 'pending' });
    const flaky = client(async () => { throw nf(); }, 5, async () => { throw new Error('rpc down'); });
    expect(await attestationStatus(SENT, 4, SENDER, flaky as never)).toEqual({ status: 'pending' });
  });

  it('unknown nonce or sender -> never dropped', async () => {
    expect(await attestationStatus(SENT, null, SENDER, client(async () => { throw nf(); }, 99) as never)).toEqual({ status: 'pending' });
    expect(await attestationStatus(SENT, 4, null, client(async () => { throw nf(); }, 99) as never)).toEqual({ status: 'pending' });
  });

  it('RPC errors decide nothing and leak nothing', async () => {
    const r = await attestationStatus(SENT, 4, SENDER, client(async () => { throw new Error('boom https://rpc/?key=SECRET'); }) as never);
    expect(r).toEqual({ status: 'error', error: 'error' });
  });
});
