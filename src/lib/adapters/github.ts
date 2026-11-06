import { XMLParser } from 'fast-xml-parser';
import type { AdapterResult, CommitFact, ReleaseFact, RepoFacts, TimeWindow } from '@/lib/types';
import { applyAggregate, errMsg, inWindow, makeCommit, type RepoRef, type ResolvedDeps } from './repoCommon';

const API = 'https://api.github.com';
const WEB = 'https://github.com';

// No DOM parser. DOCTYPE (and with it any custom entity) is stripped before parsing, so nothing user-defined expands.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (name) => name === 'entry' || name === 'link',
});
const parseXml = (body: string) => xml.parse(body.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, ''));

function ghHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim();

type Entry = Record<string, unknown>;
const feedEntries = (body: string): Entry[] => (parseXml(body)?.feed?.entry as Entry[] | undefined) ?? [];

function entryHref(e: Entry): string {
  const links = (e.link as Array<Record<string, string>> | undefined) ?? [];
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alt?.['@_href'] ?? '';
}

export function parseCommitsAtom(body: string): CommitFact[] {
  const out: CommitFact[] = [];
  for (const e of feedEntries(body)) {
    const sha = /Commit\/([0-9a-f]{7,64})/i.exec(text(e.id))?.[1] ?? /\/commit\/([0-9a-f]{7,64})/i.exec(entryHref(e))?.[1];
    const date = text(e.updated);
    if (!sha || !date) continue;
    const author = text((e.author as Entry | undefined)?.name) || 'unknown';
    out.push(makeCommit({ sha, author, date, message: text(e.title) }));
  }
  return out;
}

export function parseReleasesAtom(body: string): ReleaseFact[] {
  const out: ReleaseFact[] = [];
  for (const e of feedEntries(body)) {
    const url = entryHref(e);
    const fromUrl = /\/releases\/tag\/(.+)$/.exec(url)?.[1];
    const tag = fromUrl ? decodeURIComponent(fromUrl) : (text(e.id).split('/').pop() ?? '');
    const date = text(e.updated);
    if (!tag || !date) continue;
    const title = text(e.title);
    out.push({ tag, name: title && title !== tag ? title : null, date, url });
  }
  return out;
}

interface GhCommit {
  sha: string;
  commit: { author?: { name?: string; date?: string }; message?: string };
  author?: { login?: string } | null;
}

const toCommit = (c: GhCommit): CommitFact =>
  makeCommit({
    sha: c.sha,
    author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
    date: c.commit.author?.date ?? '',
    message: c.commit.message ?? '',
  });

export async function checkGithub(
  ref: RepoRef,
  window: TimeWindow,
  prevHeadSha: string | null,
  deps: ResolvedDeps,
): Promise<{ result: AdapterResult<RepoFacts>; etag: string | null }> {
  const base = { source: 'repo' as const, tier: 'verified' as const };
  const repoPath = `${API}/repos/${ref.repo}`;
  let calls = 0;
  let degraded = false;
  let restOpen = !!deps.token; // no token -> Atom directly (not a degradation)
  let etag: string | null = deps.prevEtag ?? null;

  const fail = (error: string) => ({ result: { ...base, ok: false, facts: null, error, calls } as AdapterResult<RepoFacts>, etag });
  const ok = (f: Omit<RepoFacts, 'host' | 'repo'>) => ({
    result: { ...base, ok: true, degraded: degraded || undefined, facts: { host: 'github' as const, repo: ref.repo, ...f }, calls } as AdapterResult<RepoFacts>,
    etag,
  });

  /** One budgeted REST call. null = REST closed (no token / budget refused / 401, 403, 429). */
  const rest = async (url: string, extra: Record<string, string> = {}) => {
    if (!restOpen) return null;
    if (!(await deps.budget(1))) {
      restOpen = false;
      degraded = true;
      return null;
    }
    calls++;
    const r = await deps.fetch(url, { headers: ghHeaders(deps.token, extra) });
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      restOpen = false;
      degraded = true;
      return null;
    }
    return r;
  };

  const atomGet = async (url: string) => {
    const r = await deps.fetch(url, { headers: { Accept: 'application/atom+xml' } });
    if (r.status !== 200) throw new Error(`http_${r.status}`);
    return r.body;
  };
  const atomCommits = async (branch: string) => {
    const all = parseCommitsAtom(await atomGet(`${WEB}/${ref.repo}/commits/${branch.split('/').map(encodeURIComponent).join('/')}.atom`));
    return { head: all[0]?.sha ?? null, commits: all.filter((c) => inWindow(c.date, window)) };
  };
  const atomReleases = async () =>
    parseReleasesAtom(await atomGet(`${WEB}/${ref.repo}/releases.atom`)).filter((r) => inWindow(r.date, window));

  try {
    // 1. repo meta (conditional)
    const metaRes = await rest(repoPath, etag ? { 'If-None-Match': etag } : {});
    if (!metaRes) {
      const branch = ref.branch ?? 'HEAD';
      const [c, releases] = [await atomCommits(branch), await atomReleases()];
      return ok({ branch, headSha: c.head ?? prevHeadSha, mode: 'atom', commits: c.commits, releases });
    }
    let branch = ref.branch ?? 'HEAD';
    let quiet = false; // nothing pushed since window start
    if (metaRes.status === 304) {
      quiet = true;
    } else if (metaRes.status === 200) {
      const meta = JSON.parse(metaRes.body) as { default_branch?: string; pushed_at?: string | null };
      branch = ref.branch ?? meta.default_branch ?? 'HEAD';
      etag = metaRes.headers.get('etag') ?? etag;
      if (meta.pushed_at && Date.parse(meta.pushed_at) < Date.parse(window.start)) quiet = true;
    } else if (metaRes.status === 404) {
      return fail('repo not found (404)');
    } else {
      return fail(`github repo meta ${metaRes.status}`);
    }

    // 2. commits
    let commits: CommitFact[] = [];
    let headSha: string | null = prevHeadSha;
    let mode: RepoFacts['mode'] = 'api';
    if (!quiet) {
      let got = false;
      let useSince = !prevHeadSha;
      if (prevHeadSha) {
        const cmp = await rest(`${repoPath}/compare/${encodeURIComponent(prevHeadSha)}...${encodeURIComponent(branch)}?per_page=100`);
        if (cmp && (cmp.status === 404 || cmp.status === 422)) {
          degraded = true; // history rewritten / prev sha gone
          useSince = true;
        } else if (cmp && cmp.status === 200) {
          const body = JSON.parse(cmp.body) as { total_commits?: number; commits?: GhCommit[]; files?: { filename: string; additions?: number; deletions?: number }[] };
          const all = body.commits ?? []; // oldest first, page 1 only
          const files = body.files ?? [];
          if ((body.total_commits ?? all.length) > all.length || files.length >= 300) {
            // truncated compare: commit list / file list incomplete, head unknown -> since-query instead
            degraded = true;
            useSince = true;
          } else {
            const inWin = all.map(toCommit).filter((c) => inWindow(c.date, window));
            // the aggregate file list only describes the whole range; if part of it is outside the window it no longer maps
            commits =
              inWin.length === all.length
                ? applyAggregate(
                    inWin,
                    files.map((f) => f.filename),
                    files.reduce((s, f) => s + (f.additions ?? 0), 0),
                    files.reduce((s, f) => s + (f.deletions ?? 0), 0),
                  )
                : inWin;
            headSha = all.length ? all[all.length - 1].sha : prevHeadSha;
            got = true;
          }
        } else if (cmp) {
          return fail(`github compare ${cmp.status}`);
        }
      }
      if (useSince) {
        const q = `sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(window.start)}&until=${encodeURIComponent(window.end)}&per_page=100`;
        const r = await rest(`${repoPath}/commits?${q}`);
        if (r && r.status === 200) {
          const list = JSON.parse(r.body) as GhCommit[]; // newest first, files not fetched per commit
          headSha = list[0]?.sha ?? prevHeadSha;
          commits = list.map(toCommit).filter((c) => inWindow(c.date, window));
          got = true;
        } else if (r) {
          return fail(`github commits ${r.status}`);
        }
      }
      if (!got) {
        const a = await atomCommits(branch); // REST closed mid-run
        commits = a.commits;
        headSha = a.head ?? prevHeadSha;
        mode = 'atom';
      }
    }

    // 3. releases
    let releases: ReleaseFact[] = [];
    const rr = await rest(`${repoPath}/releases?per_page=5`);
    if (!rr) {
      releases = await atomReleases();
    } else if (rr.status === 200) {
      const list = JSON.parse(rr.body) as { tag_name: string; name: string | null; draft?: boolean; published_at?: string | null; created_at?: string; html_url: string }[];
      releases = list
        .filter((r) => !r.draft)
        .map((r) => ({ tag: r.tag_name, name: r.name ?? null, date: r.published_at ?? r.created_at ?? '', url: r.html_url }))
        .filter((r) => inWindow(r.date, window));
    }

    return ok({ branch, headSha, mode, commits, releases });
  } catch (e) {
    return fail(errMsg(e));
  }
}
