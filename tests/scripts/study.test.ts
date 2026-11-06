import { describe, it, expect } from 'vitest';
import {
  cohortOf, windowStart, projectMetrics, median, fieldSummary, commitVsShip, renderNumbers, lookup, fillTemplate, dedupeNights,
} from '@/lib/study';

const L = '2026-11-06';
const n = (night: string, status: string, reasons?: string[], observed = false) => ({ night, status, reasons, observed });

/** 30 nights 2026-10-08..2026-11-06; `over` sets status by date, `reasons` by date, `skip` leaves nights out. */
const full = (over: Record<string, string> = {}, reasons: Record<string, string[]> = {}, skip = 0) => {
  const out = [];
  const d = new Date('2026-10-08T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    const k = d.toISOString().slice(0, 10);
    if (i >= skip) out.push(n(k, over[k] ?? 'quiet', reasons[k]));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

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
    expect(projectMetrics([], L)).toMatchObject({ coverage: 'none', active30: null, shipped30: null, lastActivity: null, daysSinceActivity: null });
  });
  it('full quiet window -> history, not active', () => {
    expect(projectMetrics(full(), L)).toMatchObject({ coverage: 'history', nights30: 30, active30: false, shipped30: false, lastActivity: null });
  });
  it('partial window (<25 nights) is unknown, not quiet', () => {
    expect(projectMetrics(full({}, {}, 10), L)).toMatchObject({ coverage: 'partial', nights30: 20, active30: null, shipped30: null });
    expect(projectMetrics(full({}, {}, 5), L)).toMatchObject({ coverage: 'history', nights30: 25, active30: false });
  });
  it('unavailable rows are not coverage and not quiet', () => {
    const allUnavail = full().map((x) => ({ ...x, status: 'unavailable' }));
    expect(projectMetrics(allUnavail, L)).toMatchObject({ coverage: 'none', nights30: 0, unavailable30: 30, active30: null });
    const mixed = full().map((x, i) => (i < 10 ? { ...x, status: 'unavailable' } : x));
    expect(projectMetrics(mixed, L)).toMatchObject({ coverage: 'partial', nights30: 20, unavailable30: 10, active30: null });
  });
  it('activity older than 30 nights counts for 90 and lastActivity only', () => {
    const m = projectMetrics([n('2026-09-01', 'building'), ...full()], L);
    expect(m.active30).toBe(false);
    expect(m.active90).toBe(true);
    expect(m.shipped90).toBe(false);
    expect(m.lastActivity).toBe('2026-09-01');
    expect(m.daysSinceActivity).toBe(66);
  });
  it('shipped night sets both flags', () => {
    const m = projectMetrics(full({ '2026-11-05': 'shipped', '2026-11-04': 'building' }), L);
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
  it('quiet30 counts full windows only; partial and none are not quiet', () => {
    const rows = [
      projectMetrics(full({ '2026-11-05': 'shipped' }), L),
      projectMetrics(full(), L),
      projectMetrics([n('2026-09-01', 'building'), ...full()], L),
      projectMetrics(full({}, {}, 10), L), // partial
      projectMetrics([], L), // none
    ];
    expect(fieldSummary(rows)).toEqual({
      n: 5, withHistory: 3, partialWindow: 1, active30: 1, shipped30: 1, quiet30: 2, unavailableNights30: 0,
      medianDaysSinceActivityAmongActive: 33.5, noActivityInHistory: 1,
    });
  });
  it('reports unavailable nights per cohort', () => {
    const rows = [projectMetrics(full().map((x, i) => (i < 3 ? { ...x, status: 'unavailable' } : x)), L)];
    expect(fieldSummary(rows)).toMatchObject({ withHistory: 1, unavailableNights30: 3 });
  });
});

describe('commitVsShip', () => {
  it('classifies over full windows only', () => {
    const r = commitVsShip([
      { name: 'A', hasPublicRepo: true, nights: full({ '2026-11-01': 'building' }, { '2026-11-01': ['repo.code_commits'] }) },
      { name: 'B', hasPublicRepo: false, nights: full({ '2026-11-01': 'shipped' }, { '2026-11-01': ['liveapp.new_deploy'] }) },
      { name: 'C', hasPublicRepo: true, nights: full({ '2026-11-01': 'shipped' }, { '2026-11-01': ['liveapp.new_deploy', 'repo.code_commits'] }) },
      { name: 'D', hasPublicRepo: true, nights: full({ '2026-11-01': 'building', '2026-11-02': 'shipped' }, { '2026-11-01': ['repo.code_commits'], '2026-11-02': ['liveapp.new_deploy'] }) },
      { name: 'E', nights: [] },
      { name: 'F', nights: [n('2026-08-20', 'building', ['repo.code_commits'])] },
      { name: 'G', hasPublicRepo: true, nights: full({ '2026-11-02': 'shipped' }, {}, 10) }, // partial
    ], L);
    expect(r.withHistory).toBe(4);
    expect(r.partialWindow).toBe(1);
    expect(r.commitsNoVerifiedShip).toEqual(['A']);
    expect(r.shipNightsWithoutCodeCommits).toEqual([{ name: 'B', nights: 1 }, { name: 'D', nights: 1 }]);
    expect(r.shipNoPublicRepo).toEqual(['B']);
  });
});

describe('renderNumbers', () => {
  const data = { field: { hackathon: { quiet30: 7, withHistory: 33, medianDaysSinceActivityAmongActive: 4 } }, list: ['a', 'b'] };
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
  it('refuses the survivor-biased median on its own', () => {
    expect(() => renderNumbers('<!-- num:field.hackathon.medianDaysSinceActivityAmongActive -->1<!-- /num -->', data)).toThrow(/survivor-biased/);
  });
  it('arrays render as length; templates fill and record keys', () => {
    expect(lookup(data, 'list')).toBe(2);
    const c = fillTemplate('x', '{field.hackathon.quiet30} of {field.hackathon.withHistory}', data);
    expect(c).toEqual({ id: 'x', text: '7 of 33', keys: ['field.hackathon.quiet30', 'field.hackathon.withHistory'], values: { 'field.hackathon.quiet30': 7, 'field.hackathon.withHistory': 33 } });
    expect(() => fillTemplate('x', '{nope.k}', data)).toThrow();
  });
});
