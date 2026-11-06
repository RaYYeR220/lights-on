import { describe, it, expect } from 'vitest';
import { cdxUrl, parseCdx, sampleCaptures, deployNights } from '@/lib/adapters/wayback';

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
  it('marks the night of the later capture when the fingerprint changes', () => {
    const r = deployNights([
      { timestamp: '20261001100000', deployFingerprint: 'a' },
      { timestamp: '20261002040000', deployFingerprint: null },
      { timestamp: '20261003043000', deployFingerprint: 'b' }, // 04:30 -> night of Oct 3
      { timestamp: '20261004060000', deployFingerprint: 'b' },
      { timestamp: '20261005060000', deployFingerprint: 'c' }, // 06:00 -> night of Oct 6
    ]);
    expect(r.map((x) => x.night)).toEqual([20261003, 20261006]);
  });
});
