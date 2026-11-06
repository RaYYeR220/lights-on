import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { insertNight, saveEvidence, upsertProject } from '@/lib/db/queries';
import { getTowerData, nightsEndingAt, TOWER_NIGHTS } from '@/lib/views/tower';
import { nightDate } from '@/lib/shift/night';
import type { EvidenceBundle, Status } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

// 12:00 UTC on Nov 6: the latest shift ran at 05:00, so the window ends at night 2026-11-06.
const NOW = new Date('2026-11-06T12:00:00Z');
const LAST = 20261106;
const WINDOW = nightsEndingAt(LAST, TOWER_NIGHTS);
/** Night `k` nights before the last one, as a date string. */
const back = (k: number) => nightDate(WINDOW[TOWER_NIGHTS - 1 - k]);

const proj = (slug: string, extra: Record<string, unknown> = {}) =>
  upsertProject(db, { slug, name: slug, source: 'base', ...extra });
const night = (projectId: number, date: string, status: Status, observed: boolean, extra: Record<string, unknown> = {}) =>
  insertNight(db, { projectId, night: date, status, observed, ...extra });

const bundle = (commits: { message: string; kind?: 'code' | 'cosmetic'; authorIsBot?: boolean }[], releases: { tag: string; name: string | null }[] = []) =>
  ({
    v: 1, rulesVersion: 'test', project: 'x', night: LAST, kind: 'nightly',
    window: { start: '', end: '' },
    sources: {
      repo: {
        source: 'repo', tier: 'verified', ok: true,
        facts: {
          host: 'github', repo: 'o/r', branch: 'main', headSha: null, mode: 'git',
          commits: commits.map((c, i) => ({
            sha: `s${i}`, author: 'a', authorIsBot: c.authorIsBot ?? false, date: '2026-11-05T10:00:00Z',
            message: c.message, files: null, additions: null, deletions: null, kind: c.kind ?? 'code',
          })),
          releases: releases.map((r) => ({ ...r, date: '2026-11-05T10:00:00Z', url: 'https://example.com' })),
        },
      },
      liveapp: null, chain: null, vibestarter: null,
    },
  }) as unknown as EvidenceBundle;

describe('getTowerData', () => {
  it('window is the 90 nights ending at the latest scheduled shift', async () => {
    expect(WINDOW).toHaveLength(90);
    expect(WINDOW[89]).toBe(LAST);
    expect(WINDOW[0]).toBe(20260809);
    // before 05:00 UTC the latest shift is the previous day's
    const early = await getTowerData(db, { now: new Date('2026-11-06T04:59:00Z') });
    expect(early.lastNight).toBe(20261105);
  });

  it('prefers the observed row over the reconstructed one for the same night', async () => {
    const p = await proj('a');
    await night(p.id, back(0), 'building', false);
    await night(p.id, back(0), 'shipped', true, { summary: 'Shipped the new swap page.' });
    await night(p.id, back(1), 'building', false);
    const d = await getTowerData(db, { now: NOW });
    const a = d.projects[0];
    expect(a.history[89]).toBe('shipped');
    expect(a.observed[89]).toBe(true);
    expect(a.history[88]).toBe('building');
    expect(a.observed[88]).toBe(false);
    expect(a.status).toBe('shipped');
    expect(a.statusObserved).toBe(true);
    expect(a.statusNight).toBe(LAST);
    expect(a.confirmedAt).not.toBeNull();
    expect(a.reconstructedNights).toBe(1);
    expect(a.summary).toBe('Shipped the new swap page.');
    expect(d.night).toBe(LAST);
    expect(d.shippedOnNight).toBe(1);
    expect(d.attested).toBe(false);
  });

  it('keeps null gaps, falls back to the latest reconstructed status, and handles projects with no rows', async () => {
    const p = await proj('gappy');
    await proj('empty');
    await night(p.id, back(10), 'quiet', false);
    await night(p.id, back(3), 'building', false);
    const d = await getTowerData(db, { now: NOW });
    const g = d.projects.find((x) => x.slug === 'gappy')!;
    expect(g.history.filter((s) => s !== null)).toHaveLength(2);
    expect(g.history[89 - 3]).toBe('building');
    expect(g.history[89 - 10]).toBe('quiet');
    expect(g.history[89]).toBeNull();
    expect(g.history[0]).toBeNull();
    expect(g.status).toBe('building');
    expect(g.statusObserved).toBe(false);
    expect(g.statusNight).toBe(WINDOW[89 - 3]);
    expect(g.confirmedAt).toBeNull();
    expect(g.reconstructedNights).toBe(2);
    const e = d.projects.find((x) => x.slug === 'empty')!;
    expect(e.history.every((s) => s === null)).toBe(true);
    expect(e.status).toBeNull();
    expect(e.lit30).toBe(0);
    expect(e.whatShipped).toEqual([]);
    // no observed night anywhere yet
    expect(d.night).toBeNull();
    expect(d.shippedOnNight).toBeNull();
  });

  it('lit30 counts shipped + building nights in the last 30 only; streak runs back from the latest night', async () => {
    const p = await proj('lit');
    for (const k of [0, 1, 2]) await night(p.id, back(k), 'building', false);
    await night(p.id, back(3), 'quiet', false);
    await night(p.id, back(5), 'shipped', false);
    await night(p.id, back(29), 'building', false); // still inside the 30
    await night(p.id, back(30), 'shipped', false); // outside
    await night(p.id, back(60), 'building', false); // outside
    const [x] = (await getTowerData(db, { now: NOW })).projects;
    expect(x.lit30).toBe(5);
    expect(x.streak).toBe(3);
  });

  it('ignores rows outside the window and hidden projects', async () => {
    const p = await proj('a');
    const h = await proj('h', { hidden: true });
    await night(p.id, '2026-08-01', 'shipped', false);
    await night(p.id, '2026-11-07', 'shipped', true);
    await night(h.id, back(0), 'shipped', true);
    const d = await getTowerData(db, { now: NOW });
    expect(d.projects.map((x) => x.slug)).toEqual(['a']);
    expect(d.projects[0].history.every((s) => s === null)).toBe(true);
    expect(d.night).toBeNull();
  });

  it('a community-added project never appears on the building, even when unhidden with nights', async () => {
    const listed = await proj('listed');
    const c = await proj('added-by-someone', { source: 'community' });
    await night(listed.id, back(0), 'quiet', true);
    await night(c.id, back(0), 'shipped', true);
    const d = await getTowerData(db, { now: NOW });
    expect(d.projects.map((x) => x.slug)).toEqual(['listed']);
    expect(d.shippedOnNight).toBe(0);
  });

  it('orders windows by their stored bay (creation order); source/name only break ties', async () => {
    await proj('zed', { name: 'Zed', source: 'base' });
    await proj('alpha', { name: 'alpha', source: 'vibeathon01' });
    await proj('beta', { name: 'Beta', source: 'base' });
    await proj('aave', { name: 'aave', source: 'base' });
    const d = await getTowerData(db, { now: NOW });
    expect(d.projects.map((x) => x.slug)).toEqual(['zed', 'alpha', 'beta', 'aave']);
  });

  it('whatShipped: notable first, then real commit subjects; never for quiet nights', async () => {
    const a = await proj('a');
    const b = await proj('b');
    const c = await proj('c');
    await night(a.id, back(0), 'shipped', true, { notable: ['New lending market for cbBTC', 'Fixed the <b>health</b> bar'] });
    await saveEvidence(db, '0xb', b.id, back(0), bundle([
      { message: 'Merge pull request #12 from o/r' },
      { message: 'chore(deps): bump x', authorIsBot: true },
      { message: 'feat: add cirBTC icon override on Ethereum (#3172)\n\nlong body' },
      { message: 'docs: readme', kind: 'cosmetic' },
      { message: 'fix: split BNB Chain log requests that Alchemy rejects (#317) see https://example.com/x' },
    ]));
    await night(b.id, back(0), 'building', false, { evidenceHash: '0xb' });
    await saveEvidence(db, '0xc', c.id, back(0), bundle([{ message: 'feat: something' }]));
    await night(c.id, back(0), 'quiet', false, { evidenceHash: '0xc' });
    const d = await getTowerData(db, { now: NOW });
    const by = Object.fromEntries(d.projects.map((x) => [x.slug, x]));
    expect(by.a.whatShipped).toEqual(['New lending market for cbBTC', 'Fixed the health bar']);
    expect(by.b.whatShipped).toEqual([
      'feat: add cirBTC icon override on Ethereum (#3172)',
      'fix: split BNB Chain log requests that Alchemy rejects (#317) see',
    ]);
    expect(by.c.whatShipped).toEqual([]);
  });

  it('whatShipped for a release or a wayback deploy names it', async () => {
    const a = await proj('a');
    const w = await proj('w');
    await saveEvidence(db, '0xr', a.id, back(0), bundle([], [{ tag: 'v2.29.0', name: null }]));
    await night(a.id, back(0), 'shipped', false, { evidenceHash: '0xr', signals: { reasons: ['repo.release'] } });
    await night(w.id, back(0), 'shipped', false, { signals: { reasons: ['liveapp.new_deploy'] } });
    const d = await getTowerData(db, { now: NOW });
    const by = Object.fromEntries(d.projects.map((x) => [x.slug, x]));
    expect(by.a.whatShipped).toEqual(['Release v2.29.0']);
    expect(by.w.whatShipped).toEqual(['New deploy seen on the live app']);
  });

  it('attested is true when a row of the latest observed night carries a uid', async () => {
    const p = await proj('a');
    await night(p.id, back(1), 'quiet', true, { attestationUid: '0x01' });
    await night(p.id, back(0), 'quiet', true, { attestationUid: '0x02' });
    const d = await getTowerData(db, { now: NOW });
    expect(d.night).toBe(LAST);
    expect(d.attested).toBe(true);
    expect(d.shippedOnNight).toBe(0);
  });
});
