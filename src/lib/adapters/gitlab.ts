import type { AdapterResult, CommitFact, ReleaseFact, RepoFacts, TimeWindow } from '@/lib/types';
import { applyAggregate, errMsg, inWindow, makeCommit, type RepoRef, type ResolvedDeps } from './repoCommon';

const API = 'https://gitlab.com/api/v4';

interface GlCommit {
  id: string;
  title?: string;
  message?: string;
  author_name?: string;
  authored_date: string;
  stats?: { additions?: number; deletions?: number } | null;
}

export async function checkGitlab(
  ref: RepoRef,
  window: TimeWindow,
  prevHeadSha: string | null,
  deps: ResolvedDeps,
): Promise<AdapterResult<RepoFacts>> {
  const base = { source: 'repo' as const, tier: 'verified' as const };
  let calls = 0;
  let degraded = false;
  const fail = (error: string, d = degraded): AdapterResult<RepoFacts> => ({ ...base, ok: false, degraded: d || undefined, facts: null, error, calls });
  const proj = `${API}/projects/${encodeURIComponent(ref.repo)}`;

  /** Budgeted call; null if the budget refused. */
  const call = async (url: string) => {
    if (!(await deps.budget(1))) return null;
    calls++;
    return deps.fetch(url, { headers: { Accept: 'application/json' } });
  };

  try {
    let branch = ref.branch;
    if (!branch) {
      const p = await call(proj);
      if (!p) return fail('budget refused', true);
      if (p.status !== 200) return fail(`gitlab project ${p.status}`);
      branch = (JSON.parse(p.body) as { default_branch?: string }).default_branch ?? 'HEAD';
    }

    const q = new URLSearchParams({ ref_name: branch, since: window.start, until: window.end, with_stats: 'true', per_page: '100' });
    const cr = await call(`${proj}/repository/commits?${q}`);
    if (!cr) return fail('budget refused', true);
    if (cr.status !== 200) return fail(`gitlab commits ${cr.status}`);
    const list = JSON.parse(cr.body) as GlCommit[]; // newest first
    const headSha = list[0]?.id ?? prevHeadSha;
    let commits: CommitFact[] = list
      .filter((c) => inWindow(c.authored_date, window))
      .map((c) =>
        makeCommit({
          sha: c.id,
          author: c.author_name ?? 'unknown',
          date: c.authored_date,
          message: c.message ?? c.title ?? '',
          additions: c.stats?.additions ?? null,
          deletions: c.stats?.deletions ?? null,
        }),
      );

    if (prevHeadSha && commits.length > 0) {
      const cmp = await call(`${proj}/repository/compare?from=${encodeURIComponent(prevHeadSha)}&to=${encodeURIComponent(branch)}`);
      if (cmp && cmp.status === 200) {
        const diffs = (JSON.parse(cmp.body) as { diffs?: { new_path?: string; old_path?: string }[] }).diffs ?? [];
        const files = diffs.map((d) => d.new_path ?? d.old_path ?? '').filter(Boolean);
        const adds = commits.reduce((s, c) => s + (c.additions ?? 0), 0);
        const dels = commits.reduce((s, c) => s + (c.deletions ?? 0), 0);
        commits = applyAggregate(commits, files, adds, dels);
      } else {
        degraded = true; // budget refused, or prev sha gone / history rewritten: keep commits without file lists
      }
    }

    let releases: ReleaseFact[] = [];
    const rr = await call(`${proj}/releases`);
    if (!rr) degraded = true;
    else if (rr.status === 200) {
      const rel = JSON.parse(rr.body) as { tag_name: string; name?: string | null; released_at?: string; created_at?: string; _links?: { self?: string } }[];
      releases = rel
        .map((r) => ({
          tag: r.tag_name,
          name: r.name ?? null,
          date: r.released_at ?? r.created_at ?? '',
          url: r._links?.self ?? `https://gitlab.com/${ref.repo}/-/releases/${encodeURIComponent(r.tag_name)}`,
        }))
        .filter((r) => inWindow(r.date, window));
    }

    return {
      ...base,
      ok: true,
      degraded: degraded || undefined,
      facts: { host: 'gitlab', repo: ref.repo, branch, headSha, mode: 'api', commits, releases },
      calls,
    };
  } catch (e) {
    return fail(errMsg(e));
  }
}
