import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, encodePacked, formatEther, http, keccak256, parseEventLogs, toBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { SCHEMA_REGISTRY_ADDRESS, EAS_ADDRESS, IDENTITY_REGISTRY_ADDRESS, easAbi, identityRegistryAbi, schemaRegistryAbi } from '@/lib/attest/abi';
import { asc, eq } from 'drizzle-orm';
import {
  attestOne, attestRoot, decodeNight, decodeRoot, encodeNight, rootSchemaUid, schemaUid, ROOT_SCHEMA, SCHEMA, type NightAttestation,
} from '@/lib/attest/eas';
import { registerAgent } from '@/lib/attest/erc8004';
import { buildNightManifest } from '@/lib/attest/manifest';
import { verifyNight } from '@/lib/attest/verify';
import { createNightlyShift, getNightManifest, insertNight, saveEvidence } from '@/lib/db/queries';
import { nights } from '@/lib/db/schema';
import type { ShiftDeps } from '@/lib/shift/deps';
import { canonicalize, hashEvidence } from '@/lib/shift/evidence';
import { finalizeShift } from '@/lib/shift/finalize';
import type { EvidenceBundle, Status } from '@/lib/types';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, NOW } from '../helpers/shift';

const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil answers receipt lookups for a not-yet-mined local tx by asking the (archive-less) upstream, which errors; retry until mined.
const FORK_URL = process.env.FORK_URL ?? 'https://base-rpc.publicnode.com';
// Throwaway key funded on the fork via anvil_setBalance. NOT anvil account 0: on Base mainnet that address
// carries an EIP-7702 delegation, so ERC-721 mints to it revert (onERC721Received hits the delegate).
const FORK_KEY = generatePrivateKey();

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
if (!hasAnvil) console.warn('SKIPPING fork tests: anvil is not on PATH (install foundry)');

const bundle = (night: number, extra = 0, project = 'demo'): EvidenceBundle => ({
  v: 1, rulesVersion: 'r1', project, night, kind: 'nightly',
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

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
  /**
   * The previous nightly flow: one multiAttest with one per-project attestation each (kept for the cost comparison).
   * An explicit gas limit skips eth_estimateGas, whose repeated runs re-fetch every fresh storage slot from upstream
   * (minutes for 52 attestations); the receipt's gasUsed is the real cost either way.
   */
  async function perProjectMultiAttest(ns: NightAttestation[]): Promise<{ uids: Hex[]; gasUsed: bigint }> {
    const hash = await wallet.writeContract({
      address: EAS_ADDRESS, abi: easAbi, functionName: 'multiAttest', gas: 450_000n * BigInt(ns.length) + 300_000n,
      args: [[{ schema: schemaUid(), data: ns.map((n) => ({ recipient: ZERO_ADDR, expirationTime: 0n, revocable: false, refUID: ('0x' + '00'.repeat(32)) as Hex, data: encodeNight(n), value: 0n })) }]],
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe('success');
    return { uids: parseEventLogs({ abi: easAbi, eventName: 'Attested', logs: rc.logs }).map((l) => l.args.uid as Hex), gasUsed: rc.gasUsed };
  }

  beforeAll(async () => {
    // --no-rate-limit: every fresh storage slot of a new attestation is fetched from the upstream RPC; anvil's default
    // compute-unit throttle makes a 52-attestation multiAttest take many minutes.
    anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await publicClient.getChainId()) === 8453) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    await publicClient.request({ method: 'anvil_setBalance', params: [account.address, '0x56bc75e2d63100000'] } as never);
    for (const [schema, uid] of [[SCHEMA, schemaUid()], [ROOT_SCHEMA, rootSchemaUid()]] as const) {
      const existing = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
      if (existing.uid !== '0x' + '00'.repeat(32)) continue;
      const hash = await wallet.writeContract({
        address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'register', args: [schema, ZERO_ADDR, false],
      });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      expect(rc.status).toBe('success');
    }
  });

  afterAll(() => { anvil?.kill(); });

  it('schemaUid and rootSchemaUid match SchemaRegistry.getSchema', async () => {
    for (const [schema, uid] of [[SCHEMA, schemaUid()], [ROOT_SCHEMA, rootSchemaUid()]] as const) {
      const s = await publicClient.readContract({ address: SCHEMA_REGISTRY_ADDRESS, abi: schemaRegistryAbi, functionName: 'getSchema', args: [uid] });
      expect(s.uid).toBe(uid);
      expect(s.schema).toBe(schema);
      expect(s.revocable).toBe(false);
      expect(s.resolver).toBe(ZERO_ADDR);
    }
  });

  it('finalizeShift attests a 3-leaf root on the fork: one tx, one uid; every row verifies in root mode; tampering does not', async () => {
    const db = await makeTestDb();
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 3 });
    const statuses: Status[] = ['shipped', 'quiet', 'building'];
    const bundles: EvidenceBundle[] = [];
    for (const [i, slug] of ['alpha', 'beta', 'gamma'].entries()) {
      const p = await seedProject(db, slug);
      const b = bundle(20261106, i, slug);
      await saveEvidence(db, hashEvidence(b), p.id, '2026-11-06', b);
      await insertNight(db, { projectId: p.id, night: '2026-11-06', status: statuses[i], observed: true, shiftId: shift.id, evidenceHash: hashEvidence(b) });
      bundles.push(b);
    }
    const before = await publicClient.getTransactionCount({ address: account.address });
    const { deps } = makeDeps(db, {
      attestRoot, agentId: 7n, siteUrl: 'https://lights-on-watch.vercel.app',
      signer: { wallet, publicClient } as unknown as ShiftDeps['signer'],
    });
    const r = await finalizeShift(shift.id, deps); // the production path: persist (pglite) before the send
    expect(r).toMatchObject({ attested: 3 });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(before + 1);

    const rows = await db.select().from(nights).where(eq(nights.shiftId, shift.id)).orderBy(asc(nights.id));
    const uid = rows[0].attestationUid as Hex;
    expect(rows.every((n) => n.attestationUid === uid && n.attestTx === r.txHash)).toBe(true);
    const rc = await publicClient.getTransactionReceipt({ hash: r.txHash! });
    expect(parseEventLogs({ abi: easAbi, eventName: 'Attested', logs: rc.logs })).toHaveLength(1);
    const a = await publicClient.readContract({ address: EAS_ADDRESS, abi: easAbi, functionName: 'getAttestation', args: [uid] });
    expect(a.schema).toBe(rootSchemaUid());
    const onchain = decodeRoot(a.data);
    expect(onchain).toMatchObject({ root: rows[0].attestRoot, night: 20261106, count: 3, agentId: 7n });
    expect(onchain.manifestURI).toBe(`https://lights-on-watch.vercel.app/api/v1/manifest/${rows[0].attestManifest}`);
    const manifest = (await getNightManifest(db, rows[0].attestManifest!))!;
    expect(keccak256(toBytes(canonicalize(manifest)))).toBe(rows[0].attestManifest);
    expect(manifest.root).toBe(onchain.root);

    for (const [i, n] of rows.entries()) {
      const row = { status: n.status, lit30: n.attestLit30!, proof: n.attestProof!, evidenceHash: n.evidenceHash };
      const v = await verifyNight(uid, bundles[i], publicClient, [account.address], { row });
      expect(v.mode).toBe('root');
      expect(v.match).toBe(true);
      expect(Object.values(v.checks).every(Boolean)).toBe(true);
      expect(v.attester).toBe(account.address);
      // tampered: one changed fact in the bundle, or a status the leaf does not commit to
      const bad = await verifyNight(uid, bundle(20261106, 99, bundles[i].project), publicClient, [account.address], { row });
      expect(bad.match).toBe(false);
      expect(bad.checks.hash).toBe(false);
      const lie = await verifyNight(uid, bundles[i], publicClient, [account.address], { row: { ...row, status: 'down' } });
      expect(lie.match).toBe(false);
      expect(lie.checks).toMatchObject({ proof: false });
      expect((await verifyNight(uid, bundles[i], publicClient, [ZERO_ADDR], { row })).match).toBe(false); // foreign allowlist
    }
    // a proof is bound to its own leaf: alpha's row cannot vouch for beta's bundle
    const a0 = rows[0];
    expect((await verifyNight(uid, bundles[1], publicClient, [account.address], {
      row: { status: a0.status, lit30: a0.attestLit30!, proof: a0.attestProof! },
    })).match).toBe(false);
  });

  it('per-project attestations (the live-run schema) verify; tampered bundle does not', async () => {
    const bundles = [20261104, 20261105, 20261106].map((n) => bundle(n));
    const r = await perProjectMultiAttest(bundles.map((b) => nightFor(b, 7n)));
    expect(r.uids).toHaveLength(3);
    expect(new Set(r.uids).size).toBe(3);
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
    const foreign = await attestOne(n, { wallet: otherWallet, publicClient, budget, unsafeNoPersist: true });
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
    const good = await attestOne(n, { wallet, publicClient, budget, unsafeNoPersist: true });
    if ('skipped' in good) throw new Error(`skipped ${good.skipped}`);
    expect((await verifyNight(good.uid, b, publicClient, [account.address])).match).toBe(true);
    const otherProject = await verifyNight(good.uid, { ...b, project: 'other' }, publicClient, [account.address]);
    expect(otherProject.match).toBe(false);
    expect(otherProject.checks).toMatchObject({ project: false });
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
    const r = await attestOne(nightFor(b, 7n), { wallet, publicClient, budget, unsafeNoPersist: true });
    if ('skipped' in r) throw new Error(`skipped ${r.skipped} ${r.error}`);
    expect((await verifyNight(r.uid, b, publicClient, [account.address])).match).toBe(true);
  });

  it('gas cap refusal sends no tx on the fork', async () => {
    const before = await publicClient.getTransactionCount({ address: account.address });
    const r = await attestOne(nightFor(bundle(20261108), 7n), { wallet, publicClient, budget: async () => false, unsafeNoPersist: true });
    expect(r).toEqual({ skipped: 'gas_cap' });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(before);
  });

  it('no persist hook and no unsafeNoPersist: refused, no tx on the fork', async () => {
    const before = await publicClient.getTransactionCount({ address: account.address });
    expect(await attestOne(nightFor(bundle(20261109), 7n), { wallet, publicClient, budget })).toEqual({ skipped: 'error', error: 'no_persist' });
    const root = { root: keccak256(toBytes('r')), night: 20261109, count: 3, agentId: 7n, manifestURI: 'https://example.test/m' };
    expect(await attestRoot(root, { wallet, publicClient, budget })).toEqual({ skipped: 'error', error: 'no_persist' });
    expect(await attestRoot(root, { wallet, publicClient, budget: async () => false, unsafeNoPersist: true })).toEqual({ skipped: 'gas_cap' });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(before);
  });

  it('registerAgent mints an ERC-8004 identity owned by the caller', async () => {
    const uri = 'https://example.test/.well-known/agent-registration.json';
    const { agentId, txHash } = await registerAgent(uri, { wallet, publicClient });
    expect(txHash).toMatch(/^0x/);
    expect(await publicClient.readContract({ address: IDENTITY_REGISTRY_ADDRESS, abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] })).toBe(account.address);
    expect(await publicClient.readContract({ address: IDENTITY_REGISTRY_ADDRESS, abi: identityRegistryAbi, functionName: 'tokenURI', args: [agentId] })).toBe(uri);
  });

  it('cost: one root over 52 project-nights vs the old per-project attestations of the same 52', async () => {
    const entries = Array.from({ length: 52 }, (_, i) => ({
      slug: `project-${i}`, night: 20261106, status: 'building' as const, lit30: i % 31, evidenceHash: keccak256(toBytes(`ev-${i}`)),
    }));
    const m = buildNightManifest(entries, 7n);
    const site = 'https://lights-on-watch.vercel.app';
    const r = await attestRoot(
      { root: m.root, night: 20261106, count: 52, agentId: 7n, manifestURI: `${site}/api/v1/manifest/${m.hash}` },
      { wallet, publicClient, budget, unsafeNoPersist: true },
    );
    if ('skipped' in r) throw new Error(`skipped ${r.skipped} ${r.error}`);
    const rootRc = await publicClient.getTransactionReceipt({ hash: r.txHash });
    const old = entries.map((e): NightAttestation => ({
      projectKey: keccak256(toBytes(e.slug)), night: 20261106, kind: 0, status: 2, lit30: e.lit30,
      evidenceHash: e.evidenceHash, agentId: 7n, evidenceURI: `${site}/api/v1/evidence/${e.evidenceHash}`,
    }));
    const one = await perProjectMultiAttest(old); // all 52 in one multiAttest: a lower bound for the old flow (it sent batches of 20)
    expect(one.uids).toHaveLength(52);
    const single = await attestOne(old[0], { wallet, publicClient, budget, unsafeNoPersist: true });
    if ('skipped' in single) throw new Error('single skipped');
    const singleGas = (await publicClient.getTransactionReceipt({ hash: single.txHash })).gasUsed;
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const gasPrice = rootRc.effectiveGasPrice;
    console.log('[fork gas]', JSON.stringify({
      rootAttest52: rootRc.gasUsed.toString(),
      multiAttest52OneTx: one.gasUsed.toString(),
      attestOnePerProject: singleGas.toString(),
      attestOneX52: (singleGas * 52n).toString(),
      forkBaseFeeWei: (block.baseFeePerGas ?? 0n).toString(),
      effectiveGasPriceWei: gasPrice.toString(),
      rootCostEth: formatEther(rootRc.gasUsed * gasPrice),
      oldCostEth: formatEther(one.gasUsed * gasPrice),
    }));
    expect(rootRc.gasUsed * 20n).toBeLessThan(one.gasUsed);
    expect(spent).toBeGreaterThan(0n); // the send path reserved gas against the budget
  }, 600_000);
});
