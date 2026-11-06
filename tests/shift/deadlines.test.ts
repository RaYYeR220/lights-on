import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { makeDeps, seedProject, stubAdapters, NOW } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns } from '@/lib/db/schema';
import { createNightlyShift, getEvidence, getNights } from '@/lib/db/queries';
import { DEADLINES_MS, runProject } from '@/lib/shift/run';
import { nightlyWindow, shiftStartFor } from '@/lib/shift/night';
import { safeFetch } from '@/lib/net/safeFetch';
import type { Adapters, ShiftDeps } from '@/lib/shift/deps';
import type { AttestDeps } from '@/lib/attest/eas';
import type { EvidenceBundle } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });
const WINDOW = nightlyWindow(shiftStartFor(NOW));
const never = () => new Promise<never>(() => {});

describe('per-stage deadlines', () => {
  it('defaults: repo 25 s, liveapp 25 s, chain 30 s, vibestarter 20 s, explain 30 s, live total 90 s', () => {
    expect(DEADLINES_MS).toEqual({ repo: 25_000, liveapp: 25_000, chain: 30_000, vibestarter: 20_000, explain: 30_000, liveTotal: 90_000 });
  });

  it('nightly: a source that misses its cap is ok:false "deadline", its fetch is aborted, the night is still written', async () => {
    const p = await seedProject(db, 'alpha');
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const signals: AbortSignal[] = [];
    // the repo adapter waits on a fetch that only ends when its signal aborts
    const fetch: ShiftDeps['fetch'] = (_url, init) => new Promise((_res, rej) => {
      const s = init?.signal;
      if (s) { signals.push(s); s.addEventListener('abort', () => rej(s.reason), { once: true }); }
    });
    const repo = vi.fn(async (_ref: unknown, _w: unknown, _h: unknown, d: { fetch: ShiftDeps['fetch'] }) => {
      await d.fetch('https://api.github.com/repos/o/r');
      throw new Error('unreachable');
    }) as unknown as Adapters['repo'];
    const chain = vi.fn(never) as unknown as Adapters['chain']; // RPC: no signal, raced
    const { deps } = makeDeps(db, {
      fetch, adapters: stubAdapters({ repo, chain }), deadlinesMs: { repo: 40, chain: 60 },
    });
    const t0 = Date.now();
    const r = await runProject(p.id, 'nightly', WINDOW, deps, undefined, { shiftId: shift.id });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const b = (await getEvidence(db, r.evidenceHash)) as EvidenceBundle;
    expect(b.sources.repo).toMatchObject({ ok: false, error: 'deadline', facts: null });
    expect(b.sources.chain).toMatchObject({ ok: false, error: 'deadline' });
    expect(b.sources.liveapp?.ok).toBe(true);
    expect(b.sources.vibestarter?.ok).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(await getNights(db, p.id)).toHaveLength(1);
  });

  it('explain past its cap: no explanation, its reservation is kept, the run still finishes', async () => {
    const p = await seedProject(db, 'alpha');
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const release = vi.fn(async () => {});
    let seen: AbortSignal | undefined;
    const explain = vi.fn(async (_b: unknown, _d: unknown, d: { budget: (n: number) => Promise<boolean>; signal?: AbortSignal }) => {
      await d.budget(500);
      seen = d.signal;
      return never();
    }) as unknown as ShiftDeps['explain'];
    const { deps } = makeDeps(db, { explain, release, deadlinesMs: { explain: 40 } });
    const r = await runProject(p.id, 'nightly', WINDOW, deps, undefined, { shiftId: shift.id });
    const [night] = await getNights(db, p.id);
    expect(night).toMatchObject({ aiOk: false, summary: null, evidenceHash: r.evidenceHash });
    expect(seen?.aborted).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });

  it('live: every stage shares the 90 s total budget; the receipt wait is cut to what is left (>= 5 s)', async () => {
    const p = await seedProject(db, 'alpha');
    const hang = vi.fn(never);
    let receiptTimeoutMs: number | undefined;
    const attest = vi.fn(async (_n: unknown, d: AttestDeps) => {
      receiptTimeoutMs = d.receiptTimeoutMs;
      return { skipped: 'disabled' as const };
    });
    const { deps } = makeDeps(db, {
      attest: attest as never,
      adapters: stubAdapters({ repo: hang as never, liveapp: hang as never, chain: hang as never, vibestarter: hang as never }),
      explain: hang as never,
      deadlinesMs: { liveTotal: 150 }, // per-stage caps stay at 20-30 s; the total budget binds
    });
    const steps: string[] = [];
    const t0 = Date.now();
    const r = await runProject(p.id, 'live', WINDOW, deps, (s) => steps.push(`${s.key}:${s.state}:${s.detail ?? ''}`));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.status).toBe('unavailable');
    expect(steps).toContain('repo:fail:unavailable (deadline)');
    expect(receiptTimeoutMs).toBe(5_000);
    expect((await db.select().from(liveRuns))[0]).toMatchObject({ status: 'done' });
  });
});

describe('safeFetch honours a caller signal', () => {
  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  it('aborts an in-flight request, and refuses to start on an aborted signal', async () => {
    const ctrl = new AbortController();
    let inner: AbortSignal | undefined;
    const p = safeFetch('http://public.test/', {
      lookup: pub, signal: ctrl.signal,
      fetch: (_u, i) => new Promise((_res, rej) => {
        inner = i?.signal ?? undefined;
        inner?.addEventListener('abort', () => rej(inner?.reason), { once: true });
      }),
    });
    await vi.waitFor(() => expect(inner).toBeDefined());
    ctrl.abort(new Error('deadline'));
    await expect(p).rejects.toThrow('deadline');
    expect(inner?.aborted).toBe(true);
    const f = vi.fn();
    await expect(safeFetch('http://public.test/', { lookup: pub, signal: ctrl.signal, fetch: f })).rejects.toThrow('deadline');
    expect(f).not.toHaveBeenCalled();
  });
});
