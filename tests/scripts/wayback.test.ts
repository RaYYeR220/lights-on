import { describe, it, expect } from 'vitest';
import { cdxUrl, parseCdx, sampleCaptures, coverage, nightPlus, type CaptureEntry } from '@/lib/adapters/wayback';

describe('wayback helpers', () => {
  it('builds the CDX url', () => {
    const u = cdxUrl('https://www.ahand.in/', new Date('2026-08-08T05:00:00Z'));
    expect(u).toContain('url=www.ahand.in&');
    expect(u).toContain('from=20260808');
    expect(u).toContain('collapse=digest');
    expect(u).toContain('filter=statuscode%3A200');
  });
  it('parses CDX json and tolerates junk', () => {
    const body = JSON.stringify([['timestamp', 'original', 'digest'], ['20261001000000', 'https://a/', 'X'], ['bad', 'y', 'z']]);
    expect(parseCdx(body)).toEqual([{ timestamp: '20261001000000', original: 'https://a/', digest: 'X' }]);
    expect(parseCdx('not json')).toEqual([]);
  });
  it('samples evenly keeping first and last', () => {
    const xs = Array.from({ length: 40 }, (_, i) => i);
    const s = sampleCaptures(xs, 15);
    expect(s).toHaveLength(15);
    expect([s[0], s[14]]).toEqual([0, 39]);
  });
  const W = new Set([20261001, 20261002, 20261003, 20261004, 20261005, 20261006, 20261007]);
  const e = (timestamp: string, idx: number, fingerprint: string | null, failed = false): CaptureEntry => ({ timestamp, idx, fingerprint, failed });

  it('nightPlus crosses month ends', () => {
    expect(nightPlus(20261031, 1)).toBe(20261101);
  });
  it('equal pair: nights in (night(A), night(C)] are quiet, with a note', () => {
    const r = coverage([e('20261001040000', 0, 'a'), e('20261004040000', 1, 'a')], W);
    expect(r.map((c) => [c.night, c.kind])).toEqual([[20261002, 'quiet'], [20261003, 'quiet'], [20261004, 'quiet']].map(([n, k]) => [n, k]));
    expect(r[0].note).toBe('inferred: same deploy fingerprint at 20261001040000 and 20261004040000');
  });
  it('equal pair is NOT claimed when an unfetched capture sits between them', () => {
    expect(coverage([e('20261001040000', 0, 'a'), e('20261004040000', 3, 'a')], W)).toEqual([]);
  });
  it('differing pair: deploy on night(C) only, nights strictly between stay unknown', () => {
    const r = coverage([e('20261001040000', 0, 'a'), e('20261004043000', 5, 'b')], W);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ night: 20261004, kind: 'deploy', note: 'deploy between 20261001040000 and 20261004043000' });
  });
  it('no claims before the first or after the last capture, or outside the window', () => {
    const r = coverage([e('20261003040000', 0, 'a'), e('20261004040000', 1, 'a')], W);
    expect(r.map((c) => c.night)).toEqual([20261004]);
    expect(coverage([e('20260901040000', 0, 'a'), e('20260902040000', 1, 'a')], W)).toEqual([]);
  });
  it('a failed capture breaks the pair: A and C are never compared across a failed B', () => {
    expect(coverage([e('20261001040000', 0, 'a'), e('20261002040000', 1, null, true), e('20261005040000', 2, 'b')], W)).toEqual([]);
    expect(coverage([e('20261001040000', 0, 'a'), e('20261002040000', 1, null, true), e('20261005040000', 2, 'a')], W)).toEqual([]);
  });
  it('a deploy claim beats a quiet claim for the same night', () => {
    const r = coverage([e('20261001040000', 0, 'a'), e('20261003040000', 1, 'a'), e('20261003043000', 2, 'b')], W);
    expect(r.find((c) => c.night === 20261003)?.kind).toBe('deploy');
  });
});
