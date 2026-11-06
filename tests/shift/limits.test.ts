import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { NOW, seedProject } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { liveRuns } from '@/lib/db/schema';
import { bumpBudget, releaseBudget, type BudgetField } from '@/lib/db/queries';
import { checkLiveLimit, hashIp, clientIp, ipKey, CAPS, LIVE_LIMITS } from '@/lib/shift/limits';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

function limitDeps(clock: { now: Date }) {
  const day = () => clock.now.toISOString().slice(0, 10);
  return {
    db,
    now: () => new Date(clock.now),
    budget: (f: BudgetField, n: number | bigint) => bumpBudget(db, day(), f, n, f === 'live_runs' ? CAPS.liveRunsPerDay : 1e18),
    release: (f: BudgetField, n: number | bigint) => releaseBudget(db, day(), f, n),
  };
}

describe('checkLiveLimit', () => {
  it('4th run from the same ip within 10 min refused with retryAfterSec > 0', async () => {
    const ps = await Promise.all(['a', 'b', 'c', 'd'].map((s) => seedProject(db, s)));
    const clock = { now: new Date(NOW) };
    const deps = limitDeps(clock);
    for (const p of ps.slice(0, 3)) {
      const r = await checkLiveLimit('ip1', p.id, deps);
      expect(r.ok).toBe(true);
      clock.now = new Date(clock.now.getTime() + 60_000);
    }
    const r4 = await checkLiveLimit('ip1', ps[3].id, deps);
    expect(r4).toMatchObject({ ok: false, reason: 'ip_limit' });
    if (r4.ok) throw new Error('unreachable');
    // oldest of the three ran at NOW; it ages out at NOW + 10 min; we are at NOW + 3 min
    expect(r4.retryAfterSec).toBe(7 * 60);
    expect(await db.select().from(liveRuns)).toHaveLength(3); // the refused request left no row
    expect((await checkLiveLimit('ip2', ps[3].id, deps)).ok).toBe(true); // other requester unaffected

    clock.now = new Date(NOW.getTime() + 10 * 60_000 + 1000);
    expect((await checkLiveLimit('ip1', ps[0].id, deps)).ok).toBe(true);
  });

  it('1 run per project per 5 min, regardless of requester', async () => {
    const p = await seedProject(db, 'a');
    const clock = { now: new Date(NOW) };
    const deps = limitDeps(clock);
    const r1 = await checkLiveLimit('ip1', p.id, deps);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const [row] = await db.select().from(liveRuns);
      expect(row).toMatchObject({ id: r1.liveRunId, projectId: p.id, requesterIpHash: 'ip1', status: 'running' });
    }
    clock.now = new Date(NOW.getTime() + 2 * 60_000);
    const r2 = await checkLiveLimit('ip2', p.id, deps);
    expect(r2).toMatchObject({ ok: false, reason: 'project_cooldown', retryAfterSec: 3 * 60 });
    clock.now = new Date(NOW.getTime() + 5 * 60_000 + 1000);
    expect((await checkLiveLimit('ip2', p.id, deps)).ok).toBe(true);
  });

  it('100 per day across everyone; refusals do not consume the daily count', async () => {
    expect(CAPS.liveRunsPerDay).toBe(100);
    const p = await seedProject(db, 'a');
    const clock = { now: new Date(NOW) };
    const deps = limitDeps(clock);
    await bumpBudget(db, '2026-11-06', 'live_runs', LIVE_LIMITS.perDay - 1, CAPS.liveRunsPerDay);
    expect((await checkLiveLimit('ip1', p.id, deps)).ok).toBe(true);
    expect(await checkLiveLimit('ip2', p.id, deps)).toMatchObject({ ok: false, reason: 'project_cooldown' });
    const q = await seedProject(db, 'b');
    const r = await checkLiveLimit('ip3', q.id, deps);
    expect(r).toMatchObject({ ok: false, reason: 'daily_cap' });
    if (!r.ok) expect(r.retryAfterSec).toBe(Math.ceil((Date.parse('2026-11-07T00:00:00Z') - NOW.getTime()) / 1000));
    const row = await db.execute(`select live_runs::text as n from budget where day='2026-11-06'` as never);
    expect((row.rows[0] as { n: string }).n).toBe('100');
  });

  it('10 per requester per UTC day, even when spread out past the 10-min window', async () => {
    const ps = await Promise.all(Array.from({ length: 12 }, (_, i) => seedProject(db, `p${i}`)));
    const clock = { now: new Date(NOW) };
    const deps = limitDeps(clock);
    for (let i = 0; i < 10; i++) {
      expect((await checkLiveLimit('ip1', ps[i].id, deps)).ok).toBe(true);
      clock.now = new Date(clock.now.getTime() + 11 * 60_000); // never trips the 3 per 10 min window
    }
    const r = await checkLiveLimit('ip1', ps[10].id, deps);
    expect(r).toMatchObject({ ok: false, reason: 'ip_daily_cap' });
    if (!r.ok) expect(r.retryAfterSec).toBe(Math.ceil((Date.parse('2026-11-07T00:00:00Z') - clock.now.getTime()) / 1000));
    expect(await db.select().from(liveRuns)).toHaveLength(10);
    expect((await checkLiveLimit('ip2', ps[10].id, deps)).ok).toBe(true); // someone else is not affected
    // the next UTC day brings a new requester hash (daily salt) and a fresh count
    clock.now = new Date('2026-11-07T00:00:01Z');
    expect((await checkLiveLimit('ip1-next-day', ps[11].id, deps)).ok).toBe(true);
    expect(LIVE_LIMITS.perIpPerDay).toBe(10);
  });

  it('a racing request that lost the reservation is refused and leaves no row', async () => {
    const p = await seedProject(db, 'a');
    const clock = { now: new Date(NOW) };
    const deps = limitDeps(clock);
    const rs = await Promise.all([checkLiveLimit('ip1', p.id, deps), checkLiveLimit('ip2', p.id, deps)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(liveRuns)).toHaveLength(1);
  });
});

describe('ip hashing', () => {
  it('never contains the raw ip, is stable within a day and rotates daily', () => {
    const h1 = hashIp('203.0.113.7', '2026-11-06', 'secret');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain('203.0.113.7');
    expect(hashIp('203.0.113.7', '2026-11-06', 'secret')).toBe(h1);
    expect(hashIp('203.0.113.7', '2026-11-07', 'secret')).not.toBe(h1);
    expect(hashIp('203.0.113.8', '2026-11-06', 'secret')).not.toBe(h1);
  });

  it('refuses to hash without a secret (no constant salt)', () => {
    expect(() => hashIp('203.0.113.7', '2026-11-06', '')).toThrow();
  });

  it('keys IPv6 on its /64; IPv4 and IPv4-mapped IPv6 on the address', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe(ipKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'));
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    expect(ipKey('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(hashIp('2001:db8:1:2::1', 'd', 's')).toBe(hashIp('2001:db8:1:2:dead:beef::', 'd', 's'));
    expect(ipKey('unknown')).toBe('unknown');
  });

  it('clientIp prefers x-real-ip, then the first x-forwarded-for hop', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '1.1.1.1' }))).toBe('198.51.100.1');
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }))).toBe('198.51.100.2');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('releaseBudget', () => {
  it('refunds without going below zero', async () => {
    await bumpBudget(db, '2026-11-06', 'gas_wei', 100n, 1000n);
    await releaseBudget(db, '2026-11-06', 'gas_wei', 40n);
    await releaseBudget(db, '2026-11-06', 'gas_wei', 500n);
    const r = await db.execute(`select gas_wei::text as g from budget where day='2026-11-06'` as never);
    expect((r.rows[0] as { g: string }).g).toBe('0');
    await releaseBudget(db, '2026-11-09', 'gas_wei', 1n); // no row: no-op
  });
});
