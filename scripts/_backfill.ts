import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..');

/** DATABASE_URL etc. from .env.local (scripts run locally, never on Vercel). */
export function loadEnv(): void {
  config({ path: path.join(ROOT, '.env.local'), quiet: true });
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

/** Input data shipped with the repo (`data/`: public project info and the 2026-11-06 probe); `--data <dir>` overrides. */
export function dataDir(): string {
  return path.resolve(arg('data') ?? path.join(ROOT, 'data'));
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function daysArg(def = 90): number {
  const n = Number(arg('days') ?? def);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('--days must be an integer 1..365');
  return n;
}

/** results/raw/backfill-<date>.json (gitignored); each script owns one top-level key so they can share the file. */
export function writeSummary(key: 'git' | 'wayback', value: unknown): string {
  const dir = path.join(ROOT, 'results', 'raw');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backfill-${new Date().toISOString().slice(0, 10)}.json`);
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  const prev = (cur[key] as { projects?: { project: string }[] } | undefined)?.projects;
  const next = value as { projects?: { project: string }[] };
  // --only runs refresh just their projects instead of replacing the whole summary
  if (prev && next.projects) {
    const fresh = new Set(next.projects.map((r) => r.project));
    value = { ...next, projects: [...prev.filter((r) => !fresh.has(r.project)), ...next.projects] };
  }
  cur[key] = value;
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  return file;
}
