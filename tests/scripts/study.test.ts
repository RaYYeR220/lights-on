import { describe, it, expect } from 'vitest';
import {
  cohortOf, windowStart, projectMetrics, median, fieldSummary, commitVsShip, renderNumbers, lookup, fillTemplate, dedupeNights,
} from '@/lib/study';

const L = '2026-11-06';
const n = (night: string, status: string, reasons?: string[], observed = false) => ({ night, status, reasons, observed });

describe('cohortOf', () => {
  it('assigns cohorts by name/source', () => {
    expect(cohortOf({ name: 'Corvo Edge', source: 'vibestarter' })).toBe('vibeathon01');
    expect(cohortOf({ name: 'Onetoken', source: 'vibestarter' })).toBe('vibeathon01');
    expect(cohortOf({ name: 'aHand', source: 'vibeathon01' })).toBe('vibeathon01');
    expect(cohortOf({ name: 'Uniswap Interface', source: 'base' })).toBe('reference');
    expect(cohortOf({ name: 'Safe{Wallet}', source: 'base' })).toBe('reference');
    expect(cohortOf({ name: 'Coal', source: 'base' })).toBe('hackathon');
    expect(cohortOf({ name: 'Vibestarter', source: 'vibestarter' })).toBe('vibestarter');
    expect(cohortOf({ name: 'Someone', source: 'community' })).toBeNull();
  });
});

describe('windows and metrics', () => {
  it('windowStart is inclusive', () => {
    expect(windowStart(L, 30)).toBe('2026-10-08');
    expect(windowStart(L, 90)).toBe('2026-08-09');
  });
  it('no rows -> coverage none, nulls (unknown, not quiet)', () => {
    const m = projectMetrics([], L);
    expect(m).toMatchObject({ coverage: 'none', active30: null, shipped30: null, lastActivity: null, daysSinceActivity: null });
  });
  it('only quiet nights -> history, not active', () => {
    const m = projectMetrics([n('2026-11-01', 'quiet'), n('2026-11-02', 'down')], L);
    expect(m).toMatchObject({ coverage: 'history', active30: false, shipped30: false, lastActivity: null, daysSinceActivity: null });
  });
  it('activity older than 30 nights counts for 90 and lastActivity only', () => {
    const m = projectMetrics([n('2026-09-01', 'building'), n('2026-11-01', 'quiet')], L);
    expect(m.active30).toBe(false);
    expect(m.active90).toBe(true);
    expect(m.shipped90).toBe(false);
    expect(m.lastActivity).toBe('2026-09-01');
    expect(m.daysSinceActivity).toBe(66);
  });
  it('shipped night sets both flags', () => {
    const m = projectMetrics([n('2026-11-05', 'shipped'), n('2026-11-04', 'building')], L);
    expect(m).toMatchObject({ active30: true, shipped30: true, lastActivity: '2026-11-05', daysSinceActivity: 1 });
  });
  it('dedupe prefers observed', () => {
    expect(dedupeNights([n('2026-11-01', 'quiet'), n('2026-11-01', 'shipped', [], true)])[0].status).toBe('shipped');
  });
});

describe('median / fieldSummary', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('quiet30 = withHistory - active30; no-coverage projects are not quiet', () => {
    const rows = [
      projectMetrics([n('2026-11-05', 'shipped')], L),
      projectMetrics([n('2026-11-05', 'quiet')], L),
      projectMetrics([n('2026-09-01', 'building'), n('2026-11-05', 'quiet')], L),
      projectMetrics([], L),
    ];
    expect(fieldSummary(rows)).toEqual({
      n: 4, withHistory: 3, active30: 1, shipped30: 1, quiet30: 2, medianDaysSinceActivity: 33.5, noActivityInHistory: 1,
    });
  });
});

describe('commitVsShip', () => {
  it('classifies', () => {
    const r = commitVsShip([
      { name: 'A', nights: [n('2026-11-01', 'building', ['repo.code_commits'])] },
      { name: 'B', nights: [n('2026-11-01', 'shipped', ['liveapp.new_deploy'])] },
      { name: 'C', nights: [n('2026-11-01', 'shipped', ['liveapp.new_deploy', 'repo.code_commits'])] },
      { name: 'D', nights: [n('2026-11-01', 'building', ['repo.code_commits']), n('2026-11-02', 'shipped', ['liveapp.new_deploy'])] },
      { name: 'E', nights: [] },
      { name: 'F', nights: [n('2026-08-20', 'building', ['repo.code_commits'])] },
    ], L);
    expect(r.withHistory).toBe(4);
    expect(r.commitsNoVerifiedShip).toEqual(['A']);
    expect(r.shipWithoutPublicCommits).toEqual([{ name: 'B', nights: 1 }, { name: 'D', nights: 1 }]);
  });
});

describe('renderNumbers', () => {
  const data = { field: { hackathon: { quiet30: 7, withHistory: 33 } }, list: ['a', 'b'] };
  const md = 'Intro <!-- num:field.hackathon.quiet30 -->?<!-- /num --> of <!-- num:field.hackathon.withHistory -->0<!-- /num --> done.\n';
  it('fills spans and is idempotent', () => {
    const once = renderNumbers(md, data);
    expect(once).toBe('Intro <!-- num:field.hackathon.quiet30 -->7<!-- /num --> of <!-- num:field.hackathon.withHistory -->33<!-- /num --> done.\n');
    expect(renderNumbers(once, data)).toBe(once);
  });
  it('errors on unknown or non-scalar keys', () => {
    expect(() => renderNumbers('<!-- num:field.nope -->1<!-- /num -->', data)).toThrow(/unknown number key/);
    expect(() => renderNumbers('<!-- num:field -->1<!-- /num -->', data)).toThrow();
  });
  it('arrays render as length; templates fill and record keys', () => {
    expect(lookup(data, 'list')).toBe(2);
    const c = fillTemplate('x', '{field.hackathon.quiet30} of {field.hackathon.withHistory}', data);
    expect(c).toEqual({ id: 'x', text: '7 of 33', keys: ['field.hackathon.quiet30', 'field.hackathon.withHistory'], values: { 'field.hackathon.quiet30': 7, 'field.hackathon.withHistory': 33 } });
    expect(() => fillTemplate('x', '{nope.k}', data)).toThrow();
  });
});
