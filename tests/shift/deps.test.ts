import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import { NOW } from '../helpers/shift';
import type { Db } from '@/lib/db';
import { bumpBudget, createNightlyShift, getShift } from '@/lib/db/queries';
import { attestDepsFor, canAttest, makeShiftDeps, type ShiftDeps } from '@/lib/shift/deps';
import { CAPS } from '@/lib/shift/limits';
import { utcDay } from '@/lib/shift/night';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });

const today = () => utcDay(new Date()); // makeShiftDeps runs on the real clock
async function counter(col: string): Promise<string> {
  const r = await db.execute(`select ${col}::text as v from budget where day='${today()}'` as never);
  return (r.rows[0] as { v: string }).v;
}

describe('makeShiftDeps: live and nightly share the daily caps, live keeps out of the nightly reserve', () => {
  it('gas: live refused while nightly still fits under the full cap', async () => {
    await bumpBudget(db, today(), 'gas_wei', 600_000_000_000_000n, CAPS.gasWeiPerDay); // 0.0006 ETH reserved today
    const live = makeShiftDeps(db, { kind: 'live' });
    const nightly = makeShiftDeps(db, { kind: 'nightly' });
    expect(await live.budget('gas_wei', 10_000_000_000_000n)).toBe(false); // live stops at 0.0005
    expect(await nightly.budget('gas_wei', 10_000_000_000_000n)).toBe(true); // nightly may go to 0.001
    expect(await nightly.budget('gas_wei', 400_000_000_000_000n)).toBe(false); // the full cap still binds nightly
    expect(await counter('gas_wei')).toBe('610000000000000');
  });

  it('llm: live refused past 900k tokens a day while nightly may use up to 1.5M', async () => {
    await bumpBudget(db, today(), 'llm_tokens', 899_000, CAPS.llmTokensPerDay);
    const live = makeShiftDeps(db, { kind: 'live' });
    const nightly = makeShiftDeps(db, { kind: 'nightly' });
    expect(await live.budget('llm_tokens', 2_000)).toBe(false);
    expect(await live.budget('llm_tokens', 1_000)).toBe(true); // exactly 900k
    expect(await nightly.budget('llm_tokens', 2_000)).toBe(true);
    expect(await counter('llm_tokens')).toBe('902000');
  });

  it('release refunds the day counter and the shift counter', async () => {
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const d = makeShiftDeps(db, { kind: 'nightly', shiftId: shift.id });
    expect(await d.budget('llm_tokens', 1_000)).toBe(true);
    await d.release!('llm_tokens', 700);
    expect(await counter('llm_tokens')).toBe('300');
    expect((await getShift(db, shift.id))?.llmTokens).toBe('300');
  });

  it('the per-shift LLM cap refuses and gives the day reservation back', async () => {
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: NOW, planned: 1 });
    const d = makeShiftDeps(db, { kind: 'nightly', shiftId: shift.id });
    expect(await d.budget('llm_tokens', CAPS.llmTokensPerShift)).toBe(true);
    expect(await d.budget('llm_tokens', 1)).toBe(false);
    expect(await counter('llm_tokens')).toBe(String(CAPS.llmTokensPerShift));
  });

  it('live runs: at most 3 GitHub REST calls per run', async () => {
    const d = makeShiftDeps(db, { kind: 'live' });
    for (let i = 0; i < 3; i++) expect(await d.budget('github_calls', 1)).toBe(true);
    expect(await d.budget('github_calls', 1)).toBe(false);
    expect(await makeShiftDeps(db, { kind: 'live' }).budget('github_calls', 1)).toBe(true); // a new run, a new cap
  });
});

describe('attestDepsFor', () => {
  it('never hands out the wallet without a registered watcher agentId', () => {
    const wallet = { account: {} } as never;
    const base = { signer: { wallet, publicClient: {} as never }, budget: async () => true } as unknown as ShiftDeps;
    const persist = async () => undefined;
    expect(attestDepsFor({ ...base, agentId: undefined }, persist).wallet).toBeNull();
    expect(attestDepsFor({ ...base, agentId: 0n }, persist).wallet).toBeNull();
    expect(attestDepsFor({ ...base, agentId: 5n }, persist).wallet).toBe(wallet);
    expect(canAttest({ agentId: 5n })).toBe(true);
    expect(canAttest({})).toBe(false);
  });

  it('production attest deps always carry the persist hook and never the unsafe flag', () => {
    const base = { signer: { wallet: { account: {} } as never, publicClient: {} as never }, budget: async () => true, agentId: 5n } as unknown as ShiftDeps;
    const persist = async () => undefined;
    const d = attestDepsFor(base, persist);
    expect(d.onBroadcast).toBe(persist);
    expect('unsafeNoPersist' in d).toBe(false);
    // @ts-expect-error onBroadcast is a required argument for production callers
    expect(() => attestDepsFor(base)).toThrow(/onBroadcast/);
  });
});
