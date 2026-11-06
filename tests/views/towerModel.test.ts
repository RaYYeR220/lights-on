import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { toTowerModel, statusLine, describeWindow, dayLabel } from '@/components/tower/model';
import { baysFor, computeGeometry } from '@/components/tower/geometry';
import { towerPrePaintScript } from '@/components/tower/prePaintScript';
import { normalizeBagsInput } from '@/components/bags/address';
import { countdown } from '@/components/tower/engine';
import type { TowerData, TowerProject } from '@/lib/views/tower';

const project = (slug: string, extra: Partial<TowerProject> = {}): TowerProject => ({
  slug, name: slug, source: 'base', status: null, statusObserved: false, statusNight: null, summary: null,
  whatShipped: [], history: Array(90).fill(null), observed: Array(90).fill(false), lit30: 0, streak: 0,
  confirmedAt: null, reconstructedNights: 0, ...extra,
});

const data = (projects: TowerProject[], night: number | null = null): TowerData => ({
  generatedAt: '2026-11-06T12:00:00.000Z', night, lastNight: 20261106, shippedOnNight: null, attested: false, projects,
});

describe('toTowerModel', () => {
  it('encodes history and observed flags as 90-char strings', () => {
    const h = Array(90).fill(null);
    h[89] = 'shipped'; h[88] = 'building'; h[0] = 'quiet'; h[1] = 'down'; h[2] = 'unavailable';
    const o = Array(90).fill(false);
    o[89] = true;
    const m = toTowerModel(data([project('a', { history: h, observed: o, status: 'shipped', statusNight: 20261106 })]));
    const w = m.wins[0];
    expect(w.h).toHaveLength(90);
    expect(w.h.slice(0, 3)).toBe('qdu');
    expect(w.h.slice(-2)).toBe('bs');
    expect(w.h[50]).toBe('-');
    expect(w.o[89]).toBe('1');
    expect(w.o[88]).toBe('0');
    expect(w.stLast).toBe(true);
    expect(w.src).toBe('Base app');
  });

  it('replay order follows confirmedAt, then the stable order', () => {
    const m = toTowerModel(data([
      project('a'),
      project('b', { confirmedAt: '2026-11-06T05:03:00.000Z' }),
      project('c', { confirmedAt: '2026-11-06T05:01:00.000Z' }),
      project('d'),
    ], 20261106));
    expect(m.wins.map((w) => w.co)).toEqual([2, 1, 0, 3]);
    expect(m.live).toBe(true);
  });

  it('always leaves open bays, in multiples of 24', () => {
    expect(baysFor(52)).toBe(96);
    expect(baysFor(92)).toBe(96);
    expect(baysFor(93)).toBe(120);
    expect(baysFor(120)).toBe(144);
  });
});

describe('window copy', () => {
  it('status lines say when and what it means', () => {
    expect(statusLine({ st: 'shipped', stLast: true, stDay: '6 Nov' })).toBe('Shipped last night: new work reached users');
    expect(statusLine({ st: 'building', stLast: false, stDay: '3 Nov' })).toBe('Building on 3 Nov: code landed, not live yet');
    expect(statusLine({ st: null, stLast: false, stDay: null })).toMatch(/^Not checked yet/);
    expect(dayLabel(20261106)).toBe('6 Nov');
  });

  it('a window that was never checked makes no claim about what reached users', () => {
    const [w] = toTowerModel(data([project('x', { name: 'X' })])).wins;
    expect(describeWindow(w)).not.toMatch(/Nothing new/);
    const [q] = toTowerModel(data([project('q', { status: 'quiet', statusNight: 20261106 })])).wins;
    expect(describeWindow(q)).toMatch(/Nothing new reached users/);
  });
});

describe('pre-paint script', () => {
  it('sets the same geometry the renderer computes', () => {
    const props = new Map<string, string>();
    const sandbox = {
      document: { documentElement: { clientWidth: 1425, style: { setProperty: (k: string, v: string) => props.set(k, v) } } },
      window: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 },
    };
    vm.runInNewContext(towerPrePaintScript(96), sandbox);
    const g = computeGeometry({ cssW: 1425, vw: 1440, vh: 900, dpr: 1, nwin: 96, railH: 28 });
    expect(props.get('--tower-peek')).toBe(`${g.peek}px`);
    expect(props.get('--tower-h')).toBe(`${g.ch}px`);
    expect(props.get('--tower-bw')).toBe(`${g.bw}px`);
    // 1440 x 900: 4 px lites, the building starts ~215 px above the fold
    expect(g.L).toBe(4);
    expect(g.peek).toBeGreaterThan(200);
    expect(g.peek).toBeLessThan(230);
  });

  it('1920 gets 6 px lites', () => {
    expect(computeGeometry({ cssW: 1905, vw: 1920, vh: 1080, dpr: 1, nwin: 96, railH: 28 }).L).toBe(6);
  });
});

describe('bags input', () => {
  it('accepts 0x addresses and ENS-looking names only', () => {
    expect(normalizeBagsInput(' 0xAbCdEf0123456789abcdef0123456789ABCDEF01 ')).toBe('0xAbCdEf0123456789abcdef0123456789ABCDEF01');
    expect(normalizeBagsInput('Vitalik.eth')).toBe('vitalik.eth');
    expect(normalizeBagsInput('me.base.eth')).toBe('me.base.eth');
    expect(normalizeBagsInput('0x123')).toBeNull();
    expect(normalizeBagsInput('vitalik')).toBeNull();
    expect(normalizeBagsInput('<script>.eth')).toBeNull();
    expect(normalizeBagsInput('')).toBeNull();
  });
});

describe('countdown', () => {
  it('counts to the next 05:00 UTC', () => {
    expect(countdown(new Date('2026-11-06T04:00:00Z'))).toBe('01:00:00');
    expect(countdown(new Date('2026-11-06T05:00:00Z'))).toBe('24:00:00');
    expect(countdown(new Date('2026-11-06T12:30:15Z'))).toBe('16:29:45');
  });
});
