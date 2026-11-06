import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, arg, daysArg, sleep, writeSummary } from './_backfill';
import { GIT_LOG_FORMAT, parseNumstatLog, buildRepoNights } from '@/lib/backfill/gitLog';
import { shiftStartFor, nightContaining, nightDate, nightOf } from '@/lib/shift/night';
import { writeReconstructed } from '@/lib/backfill/store';
import type { ReleaseFact } from '@/lib/types';

loadEnv();

const DAY = 86_400_000;
const REPO_GAP_MS = 5_000;

const hostUrl = (h: string | null) => (h === 'gitlab' ? 'https://gitlab.com' : 'https://github.com');

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
  const all = await q.listProjects(db, { includeHidden: true });
  const projects = all.filter((p) => p.repo && (!only || p.slug === only));
  const skippedNoRepo = all.filter((p) => !p.repo && (!only || p.slug === only)).map((p) => p.slug);
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
          `${hostUrl(p.repoHost)}/${p.repo}.git`, dir]);
      }
      // over-fetch (git --since filters on committer date), then keep commits whose AUTHOR date is in the window
      const overfetch = new Date(since.getTime() - 7 * DAY).toISOString();
      const log = git(['log', `--since=${overfetch}`, '--numstat', `--format=${GIT_LOG_FORMAT}`], dir);
      const commits = parseNumstatLog(log).filter((c) => {
        const t = Date.parse(c.date);
        return t >= since.getTime() && t < shiftStart.getTime();
      });
      const roots = git(['log', '--max-parents=0', '--format=%aI'], dir).split(String.fromCharCode(10)).map((l) => Date.parse(l.trim())).filter(Number.isFinite);
      if (!roots.length) throw new Error('no root commit found');
      const firstCommitDate = new Date(Math.min(...roots)).toISOString();
      const tagOut = git(['for-each-ref', 'refs/tags', '--format=%(refname:short)%x1f%(creatordate:iso-strict)'], dir);
      const releases: ReleaseFact[] = [];
      for (const line of tagOut.split(String.fromCharCode(10))) {
        const [tag, iso] = line.split(String.fromCharCode(31));
        const t = Date.parse(iso ?? '');
        if (!tag || !Number.isFinite(t) || t < since.getTime() || t >= shiftStart.getTime()) continue;
        releases.push({ tag, name: null, date: new Date(t).toISOString(), url: `${hostUrl(p.repoHost)}/${p.repo}${p.repoHost === 'gitlab' ? '/-/releases/' : '/releases/tag/'}${encodeURIComponent(tag)}` });
      }

      const nights = buildRepoNights({
        slug: p.slug, host: p.repoHost ?? 'github', repo: p.repo!, branch, commits, releases, shiftStart, days, firstCommitDate,
      });
      const firstDate = nightDate(nightContaining(new Date(firstCommitDate)));
      const existing = await q.getNights(db, p.id, { from: nightDate(nights.length ? Math.min(...nights.map((n) => n.night)) : 0) });
      const prevByDate = new Map(existing.filter((n) => !n.observed).map((n) => [n.night, n]));
      // reconstructed rows older than the repo: drop git-only ones, strip the repo source from merged ones
      const deleted = await q.deleteReconstructedGitNightsBefore(db, p.id, firstDate);
      let stripped = 0;
      for (const [date, prevRow] of prevByDate) {
        if (date >= firstDate || (prevRow.signals as { source?: string } | null)?.source !== 'git+wayback') continue;
        await writeReconstructed(db, p, nightOf(date), (b) => { b.sources.repo = null; }, { replaces: 'repo', prevRow });
        stripped++;
      }
      const counts = { shipped: 0, building: 0, quiet: 0, down: 0, unavailable: 0 };
      const outcomes = { inserted: 0, updated: 0, unchanged: 0 };
      for (const n of nights) {
        const r = await writeReconstructed(db, p, n.night, (b) => { b.sources.repo = n.bundle.sources.repo; }, {
          replaces: 'repo', prevRow: prevByDate.get(n.date) ?? null,
        });
        outcomes[r.outcome]++;
        counts[r.status]++;
      }
      const inserted = outcomes.inserted;
      const duplicate = outcomes.unchanged;
      Object.assign(row, { deletedBeforeFirstCommit: deleted, strippedRepo: stripped, firstCommitDate, ...outcomes });
      Object.assign(row, { ok: true, commits: commits.length, tags: releases.length, inserted, duplicate, ...counts });
      console.log(`${p.slug.padEnd(26)} commits=${String(commits.length).padStart(4)} tags=${releases.length} new=${inserted} upd=${outcomes.updated} same=${duplicate} cut=${deleted} shipped=${counts.shipped} building=${counts.building} quiet=${counts.quiet}`);
    } catch (e) {
      Object.assign(row, { ok: false, error: (e as Error).message });
      console.log(`${p.slug.padEnd(26)} FAILED ${(e as Error).message}`);
    }
    summary.push(row);
  }
  const file = writeSummary('git', { days, shiftStart: shiftStart.toISOString(), skipped: skippedNoRepo.map((slug) => ({ slug, reason: 'no repo' })), projects: summary });
  console.log(`summary -> ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
