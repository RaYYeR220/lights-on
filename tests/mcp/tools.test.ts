import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { insertNight, upsertProject, getProjectBySlug, setProjectHidden, moderateProject } from '@/lib/db/queries';
import {
  ToolError, getBriefing, listProjects, getProject, getNight, getProjectNights, isStillShipping, watchProject, parseRepoInput,
  resetWatchLimit, type WatchCtx,
} from '@/lib/mcp/tools';
import { schemaUid } from '@/lib/attest/eas';

const NOW = new Date('2026-11-06T12:00:00Z');
let db: Db;
const saved = { ...process.env };
beforeEach(async () => {
  db = await makeTestDb();
  process.env.INTERNAL_RUN_TOKEN = 'test-token';
  resetWatchLimit();
});
afterEach(() => { process.env = { ...saved }; });

const night = (projectId: number, n: string, status: 'shipped' | 'building' | 'quiet' | 'down' | 'unavailable', extra: Record<string, unknown> = {}) =>
  insertNight(db, { projectId, night: n, status, observed: true, signals: { reasons: ['liveapp.new_deploy'] }, summary: `sum ${n}`, ...extra });

async function seed() {
  const a = await upsertProject(db, { slug: 'revoke-cash', name: 'Revoke Cash', tagline: 'tl', source: 'base' });
  await night(a.id, '2026-11-04', 'building');
  await night(a.id, '2026-11-05', 'shipped', { evidenceHash: '0xabc', attestationUid: '0xuid', attestTx: '0xtx' });
  const r = await upsertProject(db, { slug: 'recon', name: 'Recon', source: 'vibeathon01' });
  await insertNight(db, { projectId: r.id, night: '2026-11-05', status: 'quiet', observed: false, signals: { reconstructed: true, reasons: ['none'] } });
  await upsertProject(db, { slug: 'secret', name: 'Secret', source: 'community', hidden: true });
  return { a, r };
}

const headers = (ip = '1.2.3.4') => new Headers({ 'x-real-ip': ip });
const okFetch = async () => ({ status: 200, finalUrl: 'https://x.example/', headers: new Headers(), body: '', truncated: false, latencyMs: 1 });
const okCtx = (over: Partial<WatchCtx> = {}): WatchCtx => ({
  headers: headers(),
  now: () => NOW,
  fetch: okFetch,
  schedule: () => undefined,
  runFirst: async () => undefined,
  ...over,
});

describe('read tools', () => {
  it('isStillShipping returns the agreed shape for a seeded project', async () => {
    await seed();
    const r = await isStillShipping(db, 'revoke-cash', NOW);
    expect(r).toEqual({
      slug: 'revoke-cash', status: 'shipped', streak: 2, lit30: 2, lastShip: 20261105, lastNight: 20261105,
      attestationUid: '0xuid', verifiedBy: 'EAS on Base', schemaUid: schemaUid(),
    });
  });

  it('unknown or hidden slug -> ToolError 404', async () => {
    await seed();
    for (const slug of ['nope', 'secret', 'Bad Slug!']) {
      await expect(isStillShipping(db, slug, NOW)).rejects.toMatchObject({ code: 'not_found', status: 404 });
      await expect(getProject(db, slug, NOW)).rejects.toBeInstanceOf(ToolError);
    }
  });

  it('listProjects: observed preferred, reconstructed fallback, hidden excluded, history only on request', async () => {
    const { a } = await seed();
    const l = await listProjects(db, { history: false }, NOW);
    expect(l.projects.map((p) => p.slug)).toEqual(['revoke-cash', 'recon']);
    const rc = l.projects[0];
    expect(rc).toMatchObject({ bay: a.bay, status: 'shipped', summary: 'sum 2026-11-05', record: { streak: 2, lit30: 2, lastShip: 20261105 } });
    expect(typeof rc.confirmedAt).toBe('string');
    expect(rc).not.toHaveProperty('history');
    const rec = l.projects[1];
    expect(rec).toMatchObject({ status: 'quiet', statusSource: 'reconstructed', confirmedAt: null });
    const h = await listProjects(db, { history: true }, NOW);
    expect(h.projects[0].history).toHaveLength(90);
    expect(h.projects[0].history!.slice(-3)).toEqual(['building', 'shipped', null]) // oldest first, last entry = today;
  });

  it('getProject / getNight / getProjectNights', async () => {
    await seed();
    const p = await getProject(db, 'revoke-cash', NOW);
    expect(p).toMatchObject({ slug: 'revoke-cash', record: { streak: 2 }, latestNight: { night: 20261105, status: 'shipped', observed: true, reasons: ['liveapp.new_deploy'], attestationUid: '0xuid' } });
    expect(p.vibestarter).toBeNull();
    const n = await getNight(db, 'revoke-cash', 20261104);
    expect(n).toMatchObject({ slug: 'revoke-cash', night: 20261104, status: 'building' });
    await expect(getNight(db, 'revoke-cash', 20250101)).rejects.toMatchObject({ code: 'night_not_found', status: 404 });
    await expect(getNight(db, 'revoke-cash', 99999999)).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    const ns = await getProjectNights(db, 'revoke-cash', {}, NOW);
    expect(ns.nights.map((x) => x.night)).toEqual([20261104, 20261105]);
    expect(ns.nights[1]).toMatchObject({ evidenceHash: '0xabc', attestTx: '0xtx', observed: true });
    const ranged = await getProjectNights(db, 'revoke-cash', { from: 20261105, to: 20261105 }, NOW);
    expect(ranged.nights).toHaveLength(1);
    await expect(getProjectNights(db, 'revoke-cash', { from: 20261106, to: 20261101 }, NOW)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('watchProject', () => {
  it('private / loopback URL -> blocked_url, nothing created', async () => {
    const real: WatchCtx = { headers: headers(), now: () => NOW, schedule: () => undefined, runFirst: async () => undefined };
    for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://[::1]/']) {
      await expect(watchProject(db, { liveUrl: u }, real)).rejects.toMatchObject({ code: 'blocked_url', status: 400 });
    }
    expect(await getProjectBySlug(db, '127-0-0-1')).toBeNull();
  });

  it('rejects bad inputs with fixed codes', async () => {
    await expect(watchProject(db, { liveUrl: 'ftp://x.example' }, okCtx())).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(watchProject(db, { liveUrl: 'https://u:p@x.example' }, okCtx())).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(watchProject(db, { liveUrl: 'https://x.example', repo: 'a/b/c/d' }, okCtx())).rejects.toMatchObject({ code: 'invalid_repo' });
    await expect(watchProject(db, { liveUrl: 'https://x.example', contract: '0x123' }, okCtx())).rejects.toMatchObject({ code: 'invalid_contract' });
    await expect(watchProject(db, {}, okCtx())).rejects.toMatchObject({ code: 'bad_request' });
    delete process.env.INTERNAL_RUN_TOKEN;
    await expect(watchProject(db, { liveUrl: 'https://x.example' }, okCtx())).rejects.toMatchObject({ code: 'misconfigured', status: 503 });
  });

  it('unreachable site (>=500 or fetch error) -> unreachable', async () => {
    const down = okCtx({ fetch: async () => ({ status: 503, finalUrl: '', headers: new Headers(), body: '', truncated: false, latencyMs: 1 }) });
    await expect(watchProject(db, { liveUrl: 'https://x.example' }, down)).rejects.toMatchObject({ code: 'unreachable' });
    const boom = okCtx({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(watchProject(db, { liveUrl: 'https://x.example' }, boom)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('creates a hidden community project, schedules the first run, unhides on success', async () => {
    const scheduled: Promise<unknown>[] = [];
    let ran = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = okCtx({
      schedule: (p) => { scheduled.push(p); },
      runFirst: async (project) => {
        ran++;
        await gate;
        await setProjectHidden(db, project.id, false);
      },
    });
    const r = await watchProject(db, { liveUrl: 'https://App.Example.com/path#frag', repo: 'https://github.com/o/r.git', contract: '0x4200000000000000000000000000000000000021' }, ctx);
    expect(r).toEqual({ slug: 'app-example-com', status: 'queued' });
    const row = await getProjectBySlug(db, 'app-example-com');
    expect(row).toMatchObject({ source: 'community', hidden: true, repoHost: 'github', repo: 'o/r', liveUrl: 'https://app.example.com/path' });
    expect(row?.contracts).toEqual([{ chainId: 8453, address: '0x4200000000000000000000000000000000000021', role: 'watched' }]);
    expect(row?.bay).toBeGreaterThan(0);
    release();
    await Promise.all(scheduled);
    expect(ran).toBe(1);
    expect((await getProjectBySlug(db, 'app-example-com'))?.hidden).toBe(false);
    // same URL again does not create or run again
    const again = await watchProject(db, { liveUrl: 'https://app.example.com/path' }, ctx);
    expect(again).toEqual({ slug: 'app-example-com', status: 'exists' });
    expect(scheduled).toHaveLength(1);
  });

  it('watched projects are unlisted: absent from the list, served by slug with communityAdded', async () => {
    const ctx = okCtx({ runFirst: async (p) => { await setProjectHidden(db, p.id, false); } });
    const r = await watchProject(db, { liveUrl: 'https://listed.example' }, ctx);
    await Promise.resolve();
    const l = await listProjects(db, {}, NOW);
    expect(l.projects.map((p) => p.slug)).not.toContain(r.slug);
    const p = await getProject(db, r.slug!, NOW);
    expect(p).toMatchObject({ slug: r.slug, communityAdded: true });
    expect(await isStillShipping(db, r.slug!, NOW)).toMatchObject({ slug: r.slug, status: null });
    // hidden (moderation) stays 404
    await setProjectHidden(db, (await getProjectBySlug(db, r.slug!))!.id, true);
    await expect(getProject(db, r.slug!, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it('a hidden row with the same URL is re-queued without revealing its slug; a visible one is `exists`', async () => {
    const calls: string[] = [];
    const ctx = okCtx({ runFirst: async (p) => { calls.push(p.slug); } }); // first run "fails": stays hidden
    const first = await watchProject(db, { liveUrl: 'https://retry.example/' }, ctx);
    expect(first).toEqual({ slug: 'retry-example', status: 'queued' });
    const again = await watchProject(db, { liveUrl: 'https://retry.example' }, okCtx({ ...ctx, headers: headers('2.2.2.2') }));
    expect(again).toEqual({ status: 'queued' });
    expect(calls).toEqual(['retry-example', 'retry-example']);
    expect(await db.$count((await import('@/lib/db/schema')).projects)).toBe(1);
    await setProjectHidden(db, (await getProjectBySlug(db, 'retry-example'))!.id, false);
    expect(await watchProject(db, { liveUrl: 'https://retry.example' }, okCtx({ headers: headers('3.3.3.3') })))
      .toEqual({ slug: 'retry-example', status: 'exists' });
  });

  it('a moderated row is not re-run or unhidden on resubmit; unhide restores added_by', async () => {
    const calls: string[] = [];
    const ctx = okCtx({ runFirst: async (p) => { calls.push(p.slug); } });
    await watchProject(db, { liveUrl: 'https://mod.example' }, ctx);
    const before = (await getProjectBySlug(db, 'mod-example'))!.addedBy!;
    const hid = await moderateProject(db, 'mod-example', 'hide', new Date('2026-11-06T10:00:00.000Z'));
    expect(hid).toMatchObject({ hidden: true, addedBy: `moderated:2026-11-06T10:00:00.000Z:${before}` });
    const again = await watchProject(db, { liveUrl: 'https://mod.example' }, okCtx({ ...ctx, headers: headers('4.4.4.4') }));
    expect(again).toEqual({ status: 'queued' });
    expect(calls).toEqual(['mod-example']); // only the original run
    expect((await getProjectBySlug(db, 'mod-example'))?.hidden).toBe(true);
    const un = await moderateProject(db, 'mod-example', 'unhide');
    expect(un).toMatchObject({ hidden: false, addedBy: before });
  });

  it('a slug that matches an existing project is suffixed, never overwritten', async () => {
    await upsertProject(db, { slug: 'x-example', name: 'Curated', source: 'base', liveUrl: 'https://other.example' });
    const r = await watchProject(db, { liveUrl: 'https://x.example' }, okCtx());
    expect(r.slug).toBe('x-example-2');
    expect((await getProjectBySlug(db, 'x-example'))?.name).toBe('Curated');
  });

  it('3 per day per IP hash, 50 per day global', async () => {
    for (let i = 0; i < 3; i++) await watchProject(db, { liveUrl: `https://s${i}.example` }, okCtx());
    await expect(watchProject(db, { liveUrl: 'https://s3.example' }, okCtx())).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(await getProjectBySlug(db, 's3-example')).toBeNull();
    await watchProject(db, { liveUrl: 'https://s4.example' }, okCtx({ headers: headers('9.9.9.9') })); // another IP still fits
    for (let i = 0; i < 46; i++) await watchProject(db, { liveUrl: `https://g${i}.example` }, okCtx({ headers: headers(`8.8.${i}.1`) }));
    await expect(watchProject(db, { liveUrl: 'https://over.example' }, okCtx({ headers: headers('7.7.7.7') }))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('getBriefing limiter', () => {
  it('applies even without headers (shared bucket)', async () => {
    const { resetBriefingLimit } = await import('@/lib/briefingLimit');
    resetBriefingLimit();
    for (let i = 0; i < 30; i++) await getBriefing(db, 'nope').catch(() => undefined);
    await expect(getBriefing(db, 'nope')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    resetBriefingLimit();
  });
});

describe('parseRepoInput', () => {
  it('accepts owner/name and github/gitlab urls', () => {
    expect(parseRepoInput('o/r')).toEqual({ host: 'github', repo: 'o/r' });
    expect(parseRepoInput('https://github.com/o/r/tree/main')).toEqual({ host: 'github', repo: 'o/r' });
    expect(parseRepoInput('https://gitlab.com/g/sub/r.git')).toEqual({ host: 'gitlab', repo: 'g/sub/r' });
    expect(parseRepoInput('https://evil.com/o/r')).toBeNull();
    expect(parseRepoInput('../etc')).toBeNull();
  });
});
