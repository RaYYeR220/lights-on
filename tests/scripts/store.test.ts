import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { upsertProject, insertNight, getNights, getEvidence, deleteReconstructedGitNightsBefore } from '@/lib/db/queries';
import { writeReconstructed } from '@/lib/backfill/store';
import { buildRepoNights } from '@/lib/backfill/gitLog';
import { mergeDraft } from '@/lib/backfill/seed';
import { makeCommit } from '@/lib/adapters/repoCommon';
import type { LiveAppFacts, RepoFacts } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

const live = (newDeploy: boolean): LiveAppFacts => ({
  url: 'https://x', finalUrl: 'https://x', httpStatus: 200, up: true, latencyMs: null, deployFingerprint: 'f', textHash: null, title: null, bytes: 1, newDeploy, textDelta: null,
});
const repoFacts = (code: boolean): RepoFacts => ({
  host: 'github', repo: 'o/r', branch: 'main', headSha: null, mode: 'git', releases: [],
  commits: code ? [makeCommit({ sha: 's', author: 'a', date: '2026-11-04T10:00:00Z', message: 'feat', files: ['src/a.ts'] })] : [],
});
const setLive = (n: boolean) => (b: import('@/lib/types').EvidenceBundle) => { b.sources.liveapp = { source: 'liveapp', tier: 'verified', ok: true, facts: live(n) }; };
const setRepo = (c: boolean) => (b: import('@/lib/types').EvidenceBundle) => { b.sources.repo = { source: 'repo', tier: 'verified', ok: true, facts: repoFacts(c) }; };

describe('writeReconstructed', () => {
  it('wayback-only night then git backfill keeps both sources; order does not matter', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'a', source: 'base' });
    const b = await upsertProject(db, { slug: 'b', name: 'b', source: 'base' });
    await writeReconstructed(db, a, 20261105, setLive(false), { replaces: 'liveapp' });
    await writeReconstructed(db, a, 20261105, setRepo(true), { replaces: 'repo' });
    await writeReconstructed(db, b, 20261105, setRepo(true), { replaces: 'repo' });
    await writeReconstructed(db, b, 20261105, setLive(false), { replaces: 'liveapp' });

    const [ra] = await getNights(db, a.id);
    const [rb] = await getNights(db, b.id);
    const bundle = (await getEvidence(db, ra.evidenceHash!))!;
    expect(bundle.sources.repo?.ok).toBe(true);
    expect(bundle.sources.liveapp?.ok).toBe(true);
    expect(ra.status).toBe('building');
    expect(ra.signals).toMatchObject({ source: 'git+wayback', reconstructed: true });
    expect(ra.observed).toBe(false);
    const bb = (await getEvidence(db, rb.evidenceHash!))!;
    expect({ ...bb, project: 'a' }).toEqual(bundle);
    expect(rb.status).toBe(ra.status);
  });

  it('is idempotent and re-deciding a merge upgrades the status', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'a', source: 'base' });
    expect((await writeReconstructed(db, a, 20261105, setRepo(true), { replaces: 'repo' })).outcome).toBe('inserted');
    expect((await writeReconstructed(db, a, 20261105, setRepo(true), { replaces: 'repo' })).outcome).toBe('unchanged');
    const r = await writeReconstructed(db, a, 20261105, setLive(true), { replaces: 'liveapp' });
    expect(r).toEqual({ outcome: 'updated', status: 'shipped' });
  });

  it('never touches observed rows', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'a', source: 'base' });
    await insertNight(db, { projectId: a.id, night: '2026-11-05', status: 'shipped', observed: true });
    await writeReconstructed(db, a, 20261105, setRepo(false), { replaces: 'repo' });
    const rows = await getNights(db, a.id);
    expect(rows.map((r) => [r.observed, r.status])).toEqual([[false, 'quiet'], [true, 'shipped']]);
  });
});

describe('first commit cutoff', () => {
  it('buildRepoNights writes no nights before the root commit', () => {
    const shiftStart = new Date('2026-11-05T05:00:00Z');
    const nights = buildRepoNights({
      slug: 's', host: 'github', repo: 'o/r', branch: 'main', commits: [], releases: [], shiftStart, days: 10,
      firstCommitDate: '2026-11-01T04:59:00Z', // night 20261101
    });
    expect(nights.map((n) => n.night)).toEqual([20261105, 20261104, 20261103, 20261102, 20261101]);
  });
  it('cleanup deletes only this project\'s git-only reconstructed rows before the date', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'a', source: 'base' });
    const o = await upsertProject(db, { slug: 'o', name: 'o', source: 'base' });
    await writeReconstructed(db, a, 20261030, setRepo(false), { replaces: 'repo' }); // git only, before -> deleted
    await writeReconstructed(db, a, 20261031, setLive(false), { replaces: 'liveapp' }); // wayback, before -> kept
    await writeReconstructed(db, a, 20261102, setRepo(false), { replaces: 'repo' }); // after -> kept
    await insertNight(db, { projectId: a.id, night: '2026-10-29', status: 'quiet', observed: true });
    await writeReconstructed(db, o, 20261030, setRepo(false), { replaces: 'repo' }); // other project -> kept
    expect(await deleteReconstructedGitNightsBefore(db, a.id, '2026-11-01')).toBe(1);
    expect((await getNights(db, a.id)).map((r) => r.night)).toEqual(['2026-10-29', '2026-10-31', '2026-11-02']);
    expect(await getNights(db, o.id)).toHaveLength(1);
  });
});

describe('mergeDraft', () => {
  it('drops null / undefined / empty arrays so a re-seed never blanks existing fields', () => {
    expect(mergeDraft({ slug: 'a', name: 'A', source: 'base', repo: null, liveUrl: 'https://x', contracts: [], tagline: undefined }))
      .toEqual({ slug: 'a', name: 'A', source: 'base', liveUrl: 'https://x' });
  });
});
