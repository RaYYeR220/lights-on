import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { encodeNight, encodeRoot, rootSchemaUid, schemaUid } from '@/lib/attest/eas';
import { buildNightManifest } from '@/lib/attest/manifest';
import { verifyNight } from '@/lib/attest/verify';
import type { AnyPublicClient } from '@/lib/attest/signer';
import { hashEvidence } from '@/lib/shift/evidence';
import type { EvidenceBundle, Status } from '@/lib/types';

const WATCHER = '0x00000000000000000000000000000000000000aa' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

const bundle = (project: string, night = 20261106, extra = 0): EvidenceBundle => ({
  v: 1, rulesVersion: 'r1', project, night, kind: 'nightly',
  window: { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' },
  sources: {
    repo: { source: 'repo', tier: 'verified', ok: true, facts: {
      host: 'github', repo: `o/${project}`, branch: 'main', headSha: 'abc', mode: 'api', releases: [],
      commits: [{ sha: 'abc', author: 'x', authorIsBot: false, date: '2026-11-05T10:00:00Z', message: 'm', files: ['a.ts'], additions: 1 + extra, deletions: 0, kind: 'code' }],
    } },
    liveapp: null, chain: null, vibestarter: null,
  },
});

type Att = { uid: Hex; schema: Hex; time: bigint; expirationTime: bigint; revocationTime: bigint; refUID: Hex; recipient: Address; attester: Address; revocable: boolean; data: Hex };
/** A read client over a fixed set of attestations (unknown uid -> the EAS empty struct). */
function chain(atts: Att[]) {
  const by = new Map(atts.map((a) => [a.uid.toLowerCase(), a]));
  const readContract = vi.fn(async ({ args }: { args: [Hex] }) => by.get(args[0].toLowerCase()) ?? {
    uid: ZERO32, schema: ZERO32, time: 0n, expirationTime: 0n, revocationTime: 0n, refUID: ZERO32, recipient: WATCHER, attester: '0x0000000000000000000000000000000000000000', revocable: false, data: '0x',
  });
  return { readContract } as unknown as AnyPublicClient;
}
const att = (uid: string, schema: Hex, data: Hex, o: Partial<Att> = {}): Att => ({
  uid: keccak256(toBytes(uid)), schema, time: 1n, expirationTime: 0n, revocationTime: 0n, refUID: ZERO32,
  recipient: '0x0000000000000000000000000000000000000000', attester: WATCHER, revocable: false, data, ...o,
});

/** One night's root over three projects, attested as `uid`. */
function night(n: number, uid: string, o: Partial<Att> = {}) {
  const projects: [string, Status, number][] = [['alpha', 'shipped', 12], ['beta', 'quiet', 3], ['gamma', 'building', 30]];
  const bundles = projects.map(([p]) => bundle(p, n));
  const m = buildNightManifest(projects.map(([slug, status, lit30], i) => ({ slug, night: n, status, lit30, evidenceHash: hashEvidence(bundles[i]) })), 7n);
  const a = att(uid, rootSchemaUid(), encodeRoot({ root: m.root, night: n, count: 3, agentId: 7n, manifestURI: `https://x.test/api/v1/manifest/${m.hash}` }), o);
  const rows = m.inOrder.map((l, i) => ({ status: projects[i][1], lit30: l.lit30, proof: m.proofs.get(l.leaf)!, evidenceHash: l.evidenceHash, leaf: l.leaf }));
  return { a, m, bundles, rows };
}

describe('verifyNight, root mode (nightly)', () => {
  it('every project-night of the root matches; the result names the root, the leaf and the proof length', async () => {
    const t = night(20261106, 'root-a');
    const c = chain([t.a]);
    for (const [i, row] of t.rows.entries()) {
      const r = await verifyNight(t.a.uid, t.bundles[i], c, [WATCHER], { row: { status: row.status, lit30: row.lit30, proof: row.proof } });
      expect(r.mode).toBe('root');
      expect(r.match).toBe(true);
      expect(r.checks).toEqual({ exists: true, schema: true, attester: true, notRevoked: true, notExpired: true, night: true, proof: true, hash: true });
      if (r.mode !== 'root') throw new Error('mode');
      expect(r).toMatchObject({ root: t.m.root, leaf: row.leaf, proofSteps: row.proof.length, count: 3, onchainHash: r.localHash });
      expect(r.manifestURI).toBe(`https://x.test/api/v1/manifest/${t.m.hash}`);
    }
  });

  it('a wrong status or lit30 breaks the proof', async () => {
    const t = night(20261106, 'root-a');
    const c = chain([t.a]);
    const { status, lit30, proof } = t.rows[1];
    for (const row of [{ status: 'shipped' as const, lit30, proof }, { status, lit30: lit30 + 1, proof }]) {
      const r = await verifyNight(t.a.uid, t.bundles[1], c, [WATCHER], { row });
      expect(r.match).toBe(false);
      expect(r.checks).toMatchObject({ proof: false, attester: true, night: true });
    }
  });

  it('a tampered bundle fails: through the proof, or (given the row hash) through the hash check', async () => {
    const t = night(20261106, 'root-a');
    const c = chain([t.a]);
    const tampered = bundle('alpha', 20261106, 1);
    const { status, lit30, proof, evidenceHash } = t.rows[0];
    const a = await verifyNight(t.a.uid, tampered, c, [WATCHER], { row: { status, lit30, proof } });
    expect(a.match).toBe(false);
    expect(a.checks).toMatchObject({ proof: false, hash: false });
    const b = await verifyNight(t.a.uid, tampered, c, [WATCHER], { row: { status, lit30, proof, evidenceHash } });
    expect(b.match).toBe(false);
    expect(b.checks).toMatchObject({ proof: true, hash: false }); // the row is attested; this bundle is not its evidence
    expect(b.onchainHash).toBe(evidenceHash);
    expect(b.localHash).not.toBe(evidenceHash);
  });

  it('a foreign attester of the very same root does not match (unless allowlisted)', async () => {
    const t = night(20261106, 'root-x', { attester: OTHER });
    const c = chain([t.a]);
    const row = t.rows[0];
    const r = await verifyNight(t.a.uid, t.bundles[0], c, [WATCHER], { row: { status: row.status, lit30: row.lit30, proof: row.proof } });
    expect(r.match).toBe(false);
    expect(r.checks).toMatchObject({ attester: false, proof: true, hash: true });
    expect(r.attester).toBe(OTHER);
    expect((await verifyNight(t.a.uid, t.bundles[0], c, [], { row })).match).toBe(false); // empty allowlist
    expect((await verifyNight(t.a.uid, t.bundles[0], c, [OTHER], { row })).match).toBe(true);
  });

  it('a proof from another night fails against this root, and a bundle of another night fails the night check', async () => {
    const a = night(20261106, 'root-a');
    const b = night(20261105, 'root-b');
    const c = chain([a.a, b.a]);
    const fromB = b.rows[0];
    const r1 = await verifyNight(a.a.uid, a.bundles[0], c, [WATCHER], { row: { status: fromB.status, lit30: fromB.lit30, proof: fromB.proof } });
    expect(r1.match).toBe(false);
    expect(r1.checks).toMatchObject({ proof: false, night: true });
    const r2 = await verifyNight(a.a.uid, b.bundles[0], c, [WATCHER], { row: { status: fromB.status, lit30: fromB.lit30, proof: fromB.proof } });
    expect(r2.match).toBe(false);
    expect(r2.checks).toMatchObject({ night: false, proof: false });
  });

  it('a root attestation without the row (status, lit30, proof) never matches; revoked or expiring never matches', async () => {
    const t = night(20261106, 'root-a');
    const r = await verifyNight(t.a.uid, t.bundles[0], chain([t.a]), [WATCHER]);
    expect(r).toMatchObject({ mode: 'root', match: false });
    expect(r.checks).toMatchObject({ exists: true, schema: true, proof: false });
    const row = t.rows[0];
    for (const o of [{ revocationTime: 5n }, { expirationTime: 5n }]) {
      const x = night(20261106, 'root-r', o);
      expect((await verifyNight(x.a.uid, x.bundles[0], chain([x.a]), [WATCHER], { row })).match).toBe(false);
    }
  });

  it('a missing uid or junk data never matches and never throws', async () => {
    const t = night(20261106, 'root-a');
    const row = t.rows[0];
    const none = await verifyNight(keccak256(toBytes('nope')), t.bundles[0], chain([t.a]), [WATCHER], { row });
    expect(none.match).toBe(false);
    expect(none.checks.exists).toBe(false);
    const junk = att('junk', rootSchemaUid(), '0x1234');
    expect((await verifyNight(junk.uid, t.bundles[0], chain([junk]), [WATCHER], { row })).match).toBe(false);
    const down = { readContract: vi.fn(async () => { throw new Error('rpc down'); }) } as unknown as AnyPublicClient;
    expect((await verifyNight(t.a.uid, t.bundles[0], down, [WATCHER], { row })).match).toBe(false);
  });
});

describe('verifyNight, single mode (live runs, per-project schema)', () => {
  const b = bundle('alpha', 20261106);
  const data = encodeNight({
    projectKey: keccak256(toBytes('alpha')), night: 20261106, kind: 1, status: 1, lit30: 4,
    evidenceHash: hashEvidence(b), agentId: 7n, evidenceURI: 'https://x.test/api/v1/evidence/0x',
  });

  it('still matches, with the per-project checks', async () => {
    const a = att('live', schemaUid(), data);
    const r = await verifyNight(a.uid, b, chain([a]), [WATCHER]);
    expect(r.mode).toBe('single');
    expect(r.match).toBe(true);
    expect(r.checks).toEqual({ exists: true, schema: true, attester: true, notRevoked: true, notExpired: true, project: true, night: true, hash: true });
    expect(r.onchainHash).toBe(r.localHash);
    // a row passed by a caller changes nothing for a per-project attestation
    expect((await verifyNight(a.uid, b, chain([a]), [WATCHER], { row: { status: 'quiet', lit30: 0, proof: [] } })).match).toBe(true);
  });

  it('another project, another night or a foreign schema does not match', async () => {
    const a = att('live', schemaUid(), data);
    const c = chain([a, att('foreign', keccak256(toBytes('other schema')), data)]);
    const p = await verifyNight(a.uid, { ...b, project: 'beta' }, c, [WATCHER]);
    expect(p.match).toBe(false);
    expect(p.checks).toMatchObject({ project: false });
    expect((await verifyNight(a.uid, { ...b, night: 20261107 }, c, [WATCHER])).checks).toMatchObject({ night: false });
    const f = await verifyNight(keccak256(toBytes('foreign')), b, c, [WATCHER]);
    expect(f.match).toBe(false);
    expect(f.checks.schema).toBe(false);
  });
});
