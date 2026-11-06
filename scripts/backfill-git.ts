import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, arg, daysArg, sleep, writeSummary } from './_backfill';
import { GIT_LOG_FORMAT, parseNumstatLog, buildRepoNights } from '@/lib/backfill/gitLog';
import { shiftStartFor } from '@/lib/shift/night';
import type { ReleaseFact } from '@/lib/types';

loadEnv();

const DAY = 86_400_000;
const REPO_GAP_MS = 5_000;

function git(args: string[], cwd?: string) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) throw new Error(`git ${args[0]} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} exit ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  return r.stdout;
}

async function main() {
  const days = daysArg();
  const only = arg('only');
  const shiftStart = shiftStartFor(new Date());
  const since = new Date(shiftStart.getTime() - days * DAY);
  const base = path.join(os.tmpdir(), 'lights-on-backfill');
  fs.mkdirSync(base, { recursive: true });

  const [{ getDb }, q] = await Promise.all([import('@/lib/db'), import('@/lib/db/queries')]);
  const db = await getDb();
  const projects = (await q.listProjects(db, { includeHidden: true }))
    .filter((p) => p.repo && p.repoHost === 'github' && (!only || p.slug === only));
  console.log(`backfill-git: ${projects.length} repos, ${days} nights ending ${shiftStart.toISOString()}`);

  const summary: Record<string, unknown>[] = [];
  let first = true;
  for (const p of projects) {
    if (!first) await sleep(REPO_GAP_MS);
    first = false;
    const branch = p.defaultBranch ?? 'main';
    const dir = path.join(base, p.slug);
    const row: Record<string, unknown> = { project: p.slug, repo: p.repo };
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        git(['fetch', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`, '--tags'], dir);
        git(['update-ref', 'HEAD', `refs/remotes/origin/${branch}`], dir);
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
        git(['clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', branch,
          `https://github.com/${p.repo}.git`, dir]);
      }
      const log = git(['log', `--since=${since.toISOString()}`, '--numstat', `--format=${GIT_LOG_FORMAT}`], dir);
      const commits = parseNumstatLog(log);
      const tagOut = git(['for-each-ref', 'refs/tags', '--format=%(refname:short)%x1f%(creatordate:iso-strict)'], dir);
      const releases: ReleaseFact[] = [];
      for (const line of tagOut.split('\n')) {
        const [tag, iso] = line.split('\x1f');
        const t = Date.parse(iso ?? '');
        if (!tag || !Number.isFinite(t) || t < since.getTime() || t >= shiftStart.getTime()) continue;
        releases.push({ tag, name: null, date: new Date(t).toISOString(), url: `https://github.com/${p.repo}/releases/tag/${encodeURIComponent(tag)}` });
      }

      const nights = buildRepoNights({
        slug: p.slug, host: 'github', repo: p.repo!, branch, commits, releases, shiftStart, days,
      });
      const counts = { shipped: 0, building: 0, quiet: 0, down: 0, unavailable: 0 };
      let inserted = 0;
      let duplicate = 0;
      for (const n of nights) {
        try {
          await q.insertNight(db, {
            projectId: p.id, night: n.date, shiftId: null, status: n.decision.status, observed: false,
            signals: { reconstructed: true, source: 'git', reasons: n.decision.reasons },
            evidenceHash: n.hash, aiOk: false, summary: null,
          });
          await q.saveEvidence(db, n.hash, p.id, n.date, n.bundle);
          inserted++;
          counts[n.decision.status]++;
        } catch (e) {
          if (e instanceof q.DuplicateNight) duplicate++;
          else throw e;
        }
      }
      Object.assign(row, { ok: true, commits: commits.length, tags: releases.length, inserted, duplicate, ...counts });
      console.log(`${p.slug.padEnd(26)} commits=${String(commits.length).padStart(4)} tags=${releases.length} inserted=${inserted} dup=${duplicate} shipped=${counts.shipped} building=${counts.building} quiet=${counts.quiet}`);
    } catch (e) {
      Object.assign(row, { ok: false, error: (e as Error).message });
      console.log(`${p.slug.padEnd(26)} FAILED ${(e as Error).message}`);
    }
    summary.push(row);
  }
  const file = writeSummary('git', { days, shiftStart: shiftStart.toISOString(), projects: summary });
  console.log(`summary -> ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
