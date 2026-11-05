import { describe, it, expect } from 'vitest';
import { canonicalize, hashEvidence, RULES_VERSION } from '@/lib/shift/evidence';
import type { EvidenceBundle } from '@/lib/types';

const fixture = (): EvidenceBundle => ({
  v: 1,
  rulesVersion: RULES_VERSION,
  project: 'alpha',
  night: 20261105,
  kind: 'nightly',
  window: { start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z' },
  sources: {
    repo: {
      source: 'repo',
      tier: 'verified',
      ok: true,
      facts: {
        host: 'github',
        repo: 'acme/alpha',
        branch: 'main',
        headSha: 'a'.repeat(40),
        mode: 'api',
        commits: [
          {
            sha: 'b'.repeat(40),
            author: 'dev',
            authorIsBot: false,
            date: '2026-11-04T10:00:00.000Z',
            message: 'feat: x',
            files: ['src/x.ts'],
            additions: 10,
            deletions: 2,
            kind: 'code',
          },
        ],
        releases: [],
      },
    },
    liveapp: null,
    chain: null,
    vibestarter: null,
  },
});

describe('canonicalize', () => {
  it('is key-order independent', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalize(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalize({ a: 1, b: undefined, c: { d: undefined, e: 'x' } })).toBe(
      '{"a":1,"c":{"e":"x"}}',
    );
  });

  it('keeps array order and handles null, booleans, strings, numbers', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize({ n: null, t: true, f: false, s: 'a"b', x: 1.5, z: 0 })).toBe(
      '{"f":false,"n":null,"s":"a\\"b","t":true,"x":1.5,"z":0}',
    );
  });

  it('throws on non-finite numbers, bigint and functions', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize({ a: -Infinity })).toThrow();
    expect(() => canonicalize(BigInt(10))).toThrow();
    expect(() => canonicalize({ f: () => 1 })).toThrow();
  });
});

describe('hashEvidence', () => {
  it('is independent of key order in the bundle', () => {
    const a = fixture();
    const b = {
      sources: a.sources,
      window: a.window,
      kind: a.kind,
      night: a.night,
      project: a.project,
      rulesVersion: a.rulesVersion,
      v: a.v,
    } as EvidenceBundle;
    expect(hashEvidence(b)).toBe(hashEvidence(a));
  });

  it('is a 0x-prefixed 32-byte hex string', () => {
    expect(hashEvidence(fixture())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hash changes when any fact changes', () => {
    const base = hashEvidence(fixture());

    const bumpSha = fixture();
    bumpSha.sources.repo!.facts!.headSha = 'c'.repeat(40);
    expect(hashEvidence(bumpSha)).not.toBe(base);

    const bumpAdd = fixture();
    bumpAdd.sources.repo!.facts!.commits[0].additions = 11;
    expect(hashEvidence(bumpAdd)).not.toBe(base);

    const bumpNight = fixture();
    bumpNight.night = 20261106;
    expect(hashEvidence(bumpNight)).not.toBe(base);

    const addSource = fixture();
    addSource.sources.chain = {
      source: 'chain',
      tier: 'verified',
      ok: false,
      facts: null,
      error: 'timeout',
    };
    expect(hashEvidence(addSource)).not.toBe(base);
  });

  it('hash is stable across runs', () => {
    expect(hashEvidence(fixture())).toBe('0xe1d0127eb6a1eaf27c277d745675f1f8b54b5a54a3fefccca28fb094e9df5bc1');
  });
});
