import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { SCHEMA_REGISTRY_ADDRESS, EAS_ADDRESS, IDENTITY_REGISTRY_ADDRESS, identityRegistryAbi, schemaRegistryAbi } from '@/lib/attest/abi';
import { attestMany, attestOne, decodeNight, schemaUid, SCHEMA, type NightAttestation } from '@/lib/attest/eas';
import { registerAgent } from '@/lib/attest/erc8004';
import { verifyNight } from '@/lib/attest/verify';
import { hashEvidence } from '@/lib/shift/evidence';
import type { EvidenceBundle } from '@/lib/types';

const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil answers receipt lookups for a not-yet-mined local tx by asking the (archive-less) upstream, which errors; retry until mined.
const FORK_URL = process.env.FORK_URL ?? 'https://base-rpc.publicnode.com';
// Throwaway key funded on the fork via anvil_setBalance. NOT anvil account 0: on Base mainnet that address
// carries an EIP-7702 delegation, so ERC-721 mints to it revert (onERC721Received hits the delegate).
const FORK_KEY = generatePrivateKey();

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
if (!hasAnvil) console.warn('SKIPPING fork tests: anvil is not on PATH (install foundry)');

const bundle = (night: number, extra = 0): EvidenceBundle => ({
  v: 1, rulesVersion: 'r1', project: 'demo', night, kind: 'nightly',
  window: { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' },
  sources: {
    repo: { source: 'repo', tier: 'verified', ok: true, facts: {
      host: 'github', repo: 'a/b', branch: 'main', headSha: 'abc', mode: 'api',
      commits: [{ sha: 'abc', author: 'x', authorIsBot: false, date: '2026-11-05T10:00:00Z', message: 'm', files: ['a.ts'], additions: 1 + extra, deletions: 0, kind: 'code' }],
      releases: [],
    } },
    liveapp: null, chain: null, vibestarter: null,
  },
});

const nightFor = (b: EvidenceBundle, agentId: bigint): NightAttestation => ({
  projectKey: keccak256(toBytes(b.project)), night: b.night, kind: 0, status: 1, lit30: 3,
  evidenceHash: hashEvidence(b), agentId, evidenceURI: `https://example.test/api/v1/evidence/${hashEvidence(b)}`,
});

describe.skipIf(!hasAnvil)('attestation on a Base fork', () => {
  let anvil: ChildProcess;
  const account = privateKeyToAccount(FORK_KEY);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC, { retryCount: 15, retryDelay: 300 }) });
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC, { retryCount: 15, retryDelay: 300 }) });
  let spent = 0n;
  const budget = async (w: bigint) => { spent += w; return true; };

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await publicClient.getChainId()) === 8453) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    await publicClient.request({ method: 'anvil_setBalance', params: [account.address, '0x56bc75e2d63100000'] } as never);
    const existing = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [schemaUid()] });
    if (existing.uid === '0x' + '00'.repeat(32)) {
      const hash = await wallet.writeContract({
        address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'register',
        args: [SCHEMA, '0x0000000000000000000000000000000000000000', false],
      });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      expect(rc.status).toBe('success');
    }
  });

  afterAll(() => { anvil?.kill(); });

  it('schemaUid matches SchemaRegistry.getSchema', async () => {
    const s = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [schemaUid()] });
    expect(s.uid).toBe(schemaUid());
    expect(s.schema).toBe(SCHEMA);
    expect(s.revocable).toBe(false);
  });

  it('attestMany of 3 nights then verifyNight matches; tampered bundle does not', async () => {
    const bundles = [20261104, 20261105, 20261106].map((n) => bundle(n));
    const r = await attestMany(bundles.map((b) => nightFor(b, 7n)), { wallet, publicClient, budget });
    if ('skipped' in r) throw new Error(`skipped ${r.skipped} ${r.error}`);
    expect(r.uids).toHaveLength(3);
    expect(new Set(r.uids).size).toBe(3);
    expect(spent).toBeGreaterThan(0n);
    for (let i = 0; i < 3; i++) {
      const v = await verifyNight(r.uids[i]!, bundles[i]!, publicClient);
      expect(v.match).toBe(true);
      expect(v.attester).toBe(account.address);
      expect(v.onchainHash).toBe(v.localHash);
    }
    // order preserved: uid i carries night i
    const a1 = await publicClient.readContract({ address: EAS_ADDRESS, abi: (await import('@/lib/attest/abi')).easAbi, functionName: 'getAttestation', args: [r.uids[1]!] });
    expect(decodeNight(a1.data).night).toBe(20261105);
    // negative control: one tampered fact
    const bad = await verifyNight(r.uids[0]!, bundle(20261104, 1), publicClient);
    expect(bad.match).toBe(false);
    expect(bad.onchainHash).not.toBe(bad.localHash);
  });

  it('attestOne returns a verifiable uid', async () => {
    const b = bundle(20261107);
    const r = await attestOne(nightFor(b, 7n), { wallet, publicClient, budget });
    if ('skipped' in r) throw new Error(`skipped ${r.skipped} ${r.error}`);
    expect((await verifyNight(r.uid, b, publicClient)).match).toBe(true);
  });

  it('gas cap refusal sends no tx on the fork', async () => {
    const before = await publicClient.getTransactionCount({ address: account.address });
    const r = await attestOne(nightFor(bundle(20261108), 7n), { wallet, publicClient, budget: async () => false });
    expect(r).toEqual({ skipped: 'gas_cap' });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(before);
  });

  it('registerAgent mints an ERC-8004 identity owned by the caller', async () => {
    const uri = 'https://example.test/.well-known/agent-registration.json';
    const { agentId, txHash } = await registerAgent(uri, { wallet, publicClient });
    expect(txHash).toMatch(/^0x/);
    expect(await publicClient.readContract({ address: IDENTITY_REGISTRY_ADDRESS, abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] })).toBe(account.address);
    expect(await publicClient.readContract({ address: IDENTITY_REGISTRY_ADDRESS, abi: identityRegistryAbi, functionName: 'tokenURI', args: [agentId] })).toBe(uri);
  });
});
