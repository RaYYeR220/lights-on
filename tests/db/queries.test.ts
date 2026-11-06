import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import {
  upsertProject, listProjects, getProjectBySlug, insertNight, getNights, getLatestNightly,
  DuplicateNight, bumpBudget, saveEvidence, getEvidence, insertLiveRun, updateLiveRun,
  saveSnapshot, getLastSnapshot, upsertReconstructedNight,
} from '@/lib/db/queries';
import type { EvidenceBundle } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

const proj = (slug: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name: slug, source: 'community' as const, ...extra });
const nightRow = (projectId: number, night: string, extra: Record<string, unknown> = {}) =>
  ({ projectId, night, status: 'shipped' as const, observed: true, ...extra });

describe('db queries', () => {
  it('insertNight twice for same (project, night, observed) throws DuplicateNight', async () => {
    const p = await upsertProject(db, proj('a'));
    await insertNight(db, nightRow(p.id, '2026-11-05'));
    await expect(insertNight(db, nightRow(p.id, '2026-11-05'))).rejects.toBeInstanceOf(DuplicateNight);
    // reconstructed (observed=false) row for same night is allowed
    await insertNight(db, nightRow(p.id, '2026-11-05', { observed: false }));
    expect(await getNights(db, p.id)).toHaveLength(2);
  });

  it('bumpBudget refuses beyond cap and leaves value unchanged', async () => {
    expect(await bumpBudget(db, '2026-11-06', 'llm_tokens', 60, 100)).toBe(true);
    expect(await bumpBudget(db, '2026-11-06', 'llm_tokens', 50, 100)).toBe(false);
    expect(await bumpBudget(db, '2026-11-06', 'llm_tokens', 40, 100)).toBe(true);
    expect(await bumpBudget(db, '2026-11-06', 'gas_wei', BigInt('1000000000000000000'), BigInt('1' + '0'.repeat(30)))).toBe(true);
    const r = await db.execute(`select llm_tokens::text as t from budget where day='2026-11-06'` as never);
    expect((r.rows[0] as { t: string }).t).toBe('100');
  });

  it('saveEvidence is idempotent', async () => {
    const p = await upsertProject(db, proj('a'));
    const b = { v: 1, project: 'a', night: 1 } as unknown as EvidenceBundle;
    await saveEvidence(db, '0xabc', p.id, '2026-11-05', b);
    await saveEvidence(db, '0xabc', p.id, '2026-11-05', { ...b, night: 2 } as unknown as EvidenceBundle);
    expect((await getEvidence(db, '0xabc'))?.night).toBe(1);
    expect(await getEvidence(db, '0xnope')).toBeNull();
  });

  it('listProjects hides hidden by default', async () => {
    await upsertProject(db, proj('a'));
    await upsertProject(db, proj('b', { hidden: true }));
    await upsertProject(db, proj('c', { source: 'base' }));
    expect((await listProjects(db)).map((p) => p.slug).sort()).toEqual(['a', 'c']);
    expect(await listProjects(db, { includeHidden: true })).toHaveLength(3);
    expect((await listProjects(db, { source: 'base' })).map((p) => p.slug)).toEqual(['c']);
  });

  it('upsertProject updates by slug; getProjectBySlug; latest nightly; live runs; snapshots', async () => {
    const p = await upsertProject(db, proj('a'));
    const p2 = await upsertProject(db, proj('a', { name: 'A2' }));
    expect(p2.id).toBe(p.id);
    expect((await getProjectBySlug(db, 'a'))?.name).toBe('A2');
    expect(await getProjectBySlug(db, 'zz')).toBeNull();

    await insertNight(db, nightRow(p.id, '2026-11-04'));
    await insertNight(db, nightRow(p.id, '2026-11-05'));
    expect((await getLatestNightly(db, p.id))?.night).toBe('2026-11-05');
    expect(await getNights(db, p.id, { from: '2026-11-05' })).toHaveLength(1);

    const run = await insertLiveRun(db, { projectId: p.id, steps: [], status: 'running' });
    const upd = await updateLiveRun(db, run.id, { status: 'done', tx: '0xdead' });
    expect(upd.status).toBe('done');

    expect(await getLastSnapshot(db, p.id, 'liveapp')).toBeNull();
    await saveSnapshot(db, { projectId: p.id, adapter: 'liveapp', fingerprint: 'f1', data: { x: 1 } });
    await saveSnapshot(db, { projectId: p.id, adapter: 'liveapp', fingerprint: 'f2', data: { x: 2 } });
    expect((await getLastSnapshot(db, p.id, 'liveapp'))?.fingerprint).toBe('f2');
  });
});

describe('getDb', () => {
  it('two concurrent getDb() calls with pglite://memory resolve to the same instance', async () => {
    const { getDb } = await import('@/lib/db');
    const [a, b] = await Promise.all([getDb('pglite://memory'), getDb('pglite://memory')]);
    expect(a).toBe(b);
  });

  it('upsertReconstructedNight updates observed=false rows only and never touches observed rows', async () => {
    const p = await upsertProject(db, proj('r'));
    await insertNight(db, nightRow(p.id, '2026-11-05', { status: 'building' }));
    await upsertReconstructedNight(db, nightRow(p.id, '2026-11-05', { observed: false, status: 'quiet' }));
    await upsertReconstructedNight(db, nightRow(p.id, '2026-11-05', { observed: false, status: 'shipped', evidenceHash: '0xa' }));
    const rows = await getNights(db, p.id);
    expect(rows.map((r) => [r.observed, r.status])).toEqual([[false, 'shipped'], [true, 'building']]);
    expect(rows[0].evidenceHash).toBe('0xa');
    await expect(upsertReconstructedNight(db, nightRow(p.id, '2026-11-05', { observed: true }))).rejects.toThrow();
  });
});
