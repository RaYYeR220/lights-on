import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ROOT } from '../../scripts/_backfill';
import { buildSeedProjects, type SeedFile } from '@/lib/backfill/seed';

const argv = [...process.argv];
afterEach(() => { process.argv = [...argv]; });
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

describe('script input data ships in the repo', () => {
  it('seed and study read data/ by default, --data <dir> overrides', () => {
    expect(dataDir()).toBe(path.join(ROOT, 'data'));
    process.argv = [...argv, '--data', '../research'];
    expect(dataDir()).toBe(path.resolve('../research'));
    for (const f of ['scripts/seed.ts', 'scripts/study.ts']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src).not.toContain('../research');
      expect(src).toContain('dataDir()');
    }
  });

  it('data/seed-projects.json keeps only public project fields and still builds every project', () => {
    const seed = read('seed-projects.json');
    expect(Object.keys(seed).sort()).toEqual(['_meta', 'base', 'vibeathon01']);
    const finalistKeys = new Set(['name', 'live_url', 'repo', 'serving_repo', 'category', 'contracts', 'sources']);
    const baseKeys = new Set(['name', 'description', 'category', 'live_url', 'repo_host', 'repo', 'default_branch', 'contracts', 'reference', 'sources']);
    for (const r of seed.vibeathon01) for (const k of Object.keys(r)) expect(finalistKeys.has(k), k).toBe(true);
    for (const r of seed.base) for (const k of Object.keys(r)) expect(baseKeys.has(k), k).toBe(true);
    for (const r of [...seed.vibeathon01, ...seed.base]) for (const c of r.contracts) expect(Object.keys(c).sort()).toEqual(['address', 'chainId', 'label']);
    const text = JSON.stringify(seed);
    for (const w of ['"notes"', 'x_handle', 'founder_x', '"rank"', 'rejected_candidates', 'Panel ']) expect(text).not.toContain(w);
    expect(seed.vibeathon01).toHaveLength(10);
    expect(seed.base.filter((b: { reference?: boolean }) => b.reference)).toHaveLength(8);
    expect(buildSeedProjects(seed as SeedFile, []).drafts.length).toBeGreaterThanOrEqual(52);
  });

  it('data/probe-2026-11-06.json keeps the probe result per project and nothing else', () => {
    const p = read('probe-2026-11-06.json');
    expect(Object.keys(p).sort()).toEqual(['method', 'probed_at', 'rows']);
    expect(p.rows).toHaveLength(52);
    for (const r of p.rows) expect(Object.keys(r).sort()).toEqual(['category', 'live_status', 'live_url', 'name', 'repo', 'source']);
  });
});
