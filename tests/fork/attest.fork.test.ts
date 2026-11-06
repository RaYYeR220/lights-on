import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, encodePacked, http, keccak256, parseEventLogs, toBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { SCHEMA_REGISTRY_ADDRESS, EAS_ADDRESS, IDENTITY_REGISTRY_ADDRESS, easAbi, identityRegistryAbi, schemaRegistryAbi } from '@/lib/attest/abi';
import { attestMany, attestOne, decodeNight, encodeNight, schemaUid, SCHEMA, type NightAttestation } from '@/lib/attest/eas';
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
      const v = await verifyNight(r.uids[i]!, bundles[i]!, publicClient, [account.address]);
      expect(v.match).toBe(true);
      expect(Object.values(v.checks).every(Boolean)).toBe(true);
      expect(v.attester).toBe(account.address);
      expect(v.onchainHash).toBe(v.localHash);
    }
    // order preserved: uid i carries night i
    const a1 = await publicClient.readContract({ address: EAS_ADDRESS, abi: easAbi, functionName: 'getAttestation', args: [r.uids[1]!] });
    expect(decodeNight(a1.data).night).toBe(20261105);
    // negative control: one tampered fact
    const bad = await verifyNight(r.uids[0]!, bundle(20261104, 1), publicClient, [account.address]);
    expect(bad.match).toBe(false);
    expect(bad.onchainHash).not.toBe(bad.localHash);
    expect(bad.checks.hash).toBe(false);
    expect(bad.checks.attester).toBe(true);
  });

  it('rejects a foreign attester, a foreign schema, and replay against another project/night', async () => {
    const b = bundle(20261110);
    const n = nightFor(b, 7n);
    // foreign attester: a second funded key attests the same hash under OUR schema
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    await publicClient.request({ method: 'anvil_setBalance', params: [otherAccount.address, '0x56bc75e2d63100000'] } as never);
    const otherWallet = createWalletClient({ account: otherAccount, chain: base, transport: http(RPC, { retryCount: 15, retryDelay: 300 }) });
    const foreign = await attestOne(n, { wallet: otherWallet, publicClient, budget });
    if ('skipped' in foreign) throw new Error(`skipped ${foreign.skipped} ${foreign.error}`);
    const fv = await verifyNight(foreign.uid, b, publicClient, [account.address]);
    expect(fv.match).toBe(false);
    expect(fv.checks.attester).toBe(false);
    expect(fv.checks.hash).toBe(true);
    expect(fv.attester).toBe(otherAccount.address);
    expect((await verifyNight(foreign.uid, b, publicClient, [otherAccount.address])).match).toBe(true);

    // foreign schema: register a different schema, attest the same hash under it (as our watcher)
    const otherSchema = SCHEMA + ',string extra';
    const regHash = await wallet.writeContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'register', args: [otherSchema, '0x0000000000000000000000000000000000000000', false] });
    await publicClient.waitForTransactionReceipt({ hash: regHash });
    const otherUid = keccak256(encodePacked(['string', 'address', 'bool'], [otherSchema, '0x0000000000000000000000000000000000000000', false]));
    const attHash = await wallet.writeContract({
      address: EAS_ADDRESS, abi: easAbi, functionName: 'attest',
      args: [{ schema: otherUid, data: { recipient: '0x0000000000000000000000000000000000000000', expirationTime: 0n, revocable: false, refUID: ('0x' + '00'.repeat(32)) as Hex, data: encodeNight(n), value: 0n } }],
    });
    const attRc = await publicClient.waitForTransactionReceipt({ hash: attHash });
    const fsUid = parseEventLogs({ abi: easAbi, eventName: 'Attested', logs: attRc.logs })[0]!.args.uid as Hex;
    const sv = await verifyNight(fsUid, b, publicClient, [account.address]);
    expect(sv.match).toBe(false);
    expect(sv.checks.schema).toBe(false);

    // replay a valid attestation against a bundle with a different project / night
    const good = await attestOne(n, { wallet, publicClient, budget });
    if ('skipped' in good) throw new Error(`skipped ${good.skipped}`);
    expect((await verifyNight(good.uid, b, publicClient, [account.address])).match).toBe(true);
    const otherProject = await verifyNight(good.uid, { ...b, project: 'other' }, publicClient, [account.address]);
    expect(otherProject.match).toBe(false);
    expect(otherProject.checks.project).toBe(false);
    const otherNight = await verifyNight(good.uid, { ...b, night: 20261111 }, publicClient, [account.address]);
    expect(otherNight.match).toBe(false);
    expect(otherNight.checks.night).toBe(false);

    // nonexistent uid and empty allowlist never match, never throw
    const none = await verifyNight(('0x' + '12'.repeat(32)) as Hex, b, publicClient, [account.address]);
    expect(none.match).toBe(false);
    expect(none.checks.exists).toBe(false);
    expect((await verifyNight(good.uid, b, publicClient, [])).match).toBe(false);
  });

  it('attestOne returns a verifiable uid', async () => {
    const b = bundle(20261107);
    const r = await attestOne(nightFor(b, 7n), { wallet, publicClient, budget });
    if ('skipped' in r) throw new Error(`skipped ${r.skipped} ${r.error}`);
    expect((await verifyNight(r.uid, b, publicClient, [account.address])).match).toBe(true);
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
