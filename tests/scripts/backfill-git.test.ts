import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNumstatLog } from '@/lib/backfill/gitLog';
import { nightContaining, nightNumber } from '@/lib/shift/night';

const fixture = readFileSync(path.resolve(__dirname, '../fixtures/git/numstat.txt'), 'utf8');

describe('parseNumstatLog', () => {
  const commits = parseNumstatLog(fixture);

  it('parses every commit with sha, author, UTC date and subject', () => {
    expect(commits.map((c) => c.sha)).toEqual(['aaaaaaaa1111', 'bbbbbbbb2222', 'cccccccc3333', 'dddddddd4444']);
    expect(commits[0].author).toBe('Alice');
    expect(commits[0].date).toBe('2026-11-02T08:15:00.000Z');
    expect(commits[0].message).toBe('feat: add vault page');
  });

  it('sums stats, treats binary "-\t-" as a file with 0 lines', () => {
    expect(commits[0].files).toEqual(['src/app/vault/page.tsx', 'src/lib/vault.ts', 'public/hero.png']);
    expect(commits[0].additions).toBe(17);
    expect(commits[0].deletions).toBe(3);
    expect(commits[0].kind).toBe('code');
  });

  it('flags bots and classifies lockfile-only commits as cosmetic', () => {
    expect(commits[1].authorIsBot).toBe(true);
    expect(commits[1].kind).toBe('cosmetic');
  });

  it('resolves renames to the new path (plain and brace forms)', () => {
    expect(commits[2].files).toEqual(['src/new/a.ts', 'docs/manual/intro.md', 'src/lib/util.ts']);
    expect(commits[2].kind).toBe('code');
  });

  it('keeps empty (merge) commits with files=null and classifies by message', () => {
    expect(commits[3].files).toBeNull();
    expect(commits[3].additions).toBeNull();
    expect(commits[3].kind).toBe('cosmetic');
  });

  it('returns [] for empty output', () => {
    expect(parseNumstatLog('')).toEqual([]);
    expect(parseNumstatLog('\n')).toEqual([]);
  });
});

describe('nightContaining', () => {
  it('04:59 UTC and the previous day 05:00 are the same night', () => {
    expect(nightContaining(new Date('2026-11-05T04:59:59.999Z'))).toBe(20261105);
    expect(nightContaining(new Date('2026-11-04T05:00:00.000Z'))).toBe(20261105);
  });
  it('05:00 UTC starts the next night', () => {
    expect(nightContaining(new Date('2026-11-05T05:00:00.000Z'))).toBe(20261106);
    expect(nightContaining(new Date('2026-12-31T12:00:00.000Z'))).toBe(nightNumber(new Date('2027-01-01T00:00:00Z')));
  });
});
