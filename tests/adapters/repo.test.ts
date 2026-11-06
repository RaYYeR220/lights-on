import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkRepo, checkRepoDetailed } from '@/lib/adapters/repo';
import { BlockedUrl } from '@/lib/net/safeFetch';
import type { SafeFetchResult } from '@/lib/net/safeFetch';

const fx = (p: string) => readFileSync(path.join(__dirname, '..', 'fixtures', p), 'utf8');
const json = (p: string) => JSON.parse(fx(p));

const res = (body: string, status = 200, headers: Record<string, string> = {}): SafeFetchResult => ({
  status,
  finalUrl: 'https://x.test/',
  headers: new Headers(headers),
  body,
  truncated: false,
  latencyMs: 1,
});

type Route = [RegExp, () => SafeFetchResult];
function mock(routes: Route[]) {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    log.push({ url, headers: init?.headers ?? {} });
    for (const [re, fn] of routes) if (re.test(url)) return fn();
    return res('not found', 404);
  };
  return { fetch, log, urls: () => log.map((l) => l.url) };
}

const WIN = { start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z' };
const PREV = '0000000000000000000000000000000000000000';
const REF = { host: 'github' as const, repo: 'RevokeCash/revoke.cash' };
const budgetAlways = async () => true;
const META_RE = /api\.github\.com\/repos\/[^/]+\/[^/]+$/;

const meta = (pushed = '2026-11-04T20:00:00Z') => () =>
  res(JSON.stringify({ ...json('github/meta.json'), default_branch: 'main', pushed_at: pushed }), 200, { etag: 'W/"abc"' });
const ghRoutes = (extra: Route[] = []): Route[] => [
  ...extra,
  [META_RE, meta()],
  [/\/compare\//, () => res(fx('github/compare.json'))],
  [/\/releases\?/, () => res(fx('github/releases.json'))],
];

describe('github api path', () => {
  it('uses exactly 3 REST calls (meta, compare, releases), auth headers, budget before each', async () => {
    const m = mock(ghRoutes());
    const spent: number[] = [];
    const r = await checkRepo(REF, WIN, PREV, {
      fetch: m.fetch,
      token: 'ghp_x',
      budget: async (n) => (spent.push(n), true),
      prevEtag: 'W/"old"',
    });
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(3);
    expect(spent).toEqual([1, 1, 1]);
    expect(m.log).toHaveLength(3);
    expect(m.urls()[0]).toBe('https://api.github.com/repos/RevokeCash/revoke.cash');
    expect(m.urls()[1]).toContain(`/compare/${PREV}...main`);
    expect(m.urls()[2]).toMatch(/\/releases\?per_page=5/);
    expect(m.log[0].headers['If-None-Match']).toBe('W/"old"');
    expect(m.log[0].headers.Authorization).toBe('Bearer ghp_x');
    expect(m.log[0].headers.Accept).toBe('application/vnd.github+json');
    expect(m.log[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    const f = r.facts!;
    expect(f.mode).toBe('api');
    expect(f.branch).toBe('main');
    expect(f.headSha).toBe('cccc000000000000000000000000000000000003');
    expect(f.commits.map((c) => c.sha[0])).toEqual(['a', 'b']) // c authored Nov 5 09:15, outside window;
    expect(f.releases.map((x) => x.tag)).toEqual(['v2.4.0']); // old + draft excluded
    expect(r.degraded).toBeFalsy();
  });

  it('returns the new etag via checkRepoDetailed', async () => {
    const m = mock(ghRoutes());
    const d = await checkRepoDetailed(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(d.etag).toBe('W/"abc"');
    expect(d.result.ok).toBe(true);
  });

  it('bot commits flagged; multi-commit with mixed files keeps message-based kind', async () => {
    const m = mock(ghRoutes());
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    const c = r.facts!.commits;
    expect(c[1].authorIsBot).toBe(true);
    expect(c[1].author).toBe('dependabot[bot]');
    expect(c[0].authorIsBot).toBe(false);
    expect(c[1].kind).toBe('cosmetic');
    expect(c[0].kind).toBe('code');
  });

  it('single commit in window gets aggregate files, stats and path-based kind', async () => {
    const one = json('github/compare.json');
    one.commits = [one.commits[0]];
    const m = mock(ghRoutes([[/\/compare\//, () => res(JSON.stringify(one))]]));
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    const c = r.facts!.commits[0];
    expect(c.files).toContain('lib/chains/matchain.ts');
    expect(c.additions).toBe(53);
    expect(c.deletions).toBe(13);
    expect(c.kind).toBe('code');
  });

  it('docs-only aggregate makes every commit cosmetic even when messages look like code', async () => {
    const m = mock(ghRoutes([[/\/compare\//, () => res(fx('github/compare-docs-only.json'))]]));
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(r.facts!.commits.map((c) => c.kind)).toEqual(['cosmetic', 'cosmetic']);
  });

  it('commits outside the window are excluded (by author date)', async () => {
    const cmp = json('github/compare.json');
    cmp.commits[2].commit.author.date = '2026-11-05T09:15:00Z'; // after end
    cmp.commits[0].commit.author.date = '2026-11-03T23:59:59Z'; // before start
    const m = mock(ghRoutes([[/\/compare\//, () => res(JSON.stringify(cmp))]]));
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(r.facts!.commits.map((c) => c.sha[0])).toEqual(['b']);
    expect(r.facts!.headSha).toBe('cccc000000000000000000000000000000000003');
  });

  it('compare 404 (history rewritten) -> since-query fallback, degraded, files null, never throws', async () => {
    const newestFirst = json('github/compare.json').commits.reverse();
    const m = mock(
      ghRoutes([
        [/\/compare\//, () => res('{"message":"Not Found"}', 404)],
        [/\/commits\?/, () => res(JSON.stringify(newestFirst))],
      ]),
    );
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.calls).toBe(4); // meta + compare(404) + commits + releases
    const fb = m.urls().find((u) => /\/commits\?/.test(u))!;
    expect(fb).toContain('sha=main');
    expect(fb).toContain(`since=${encodeURIComponent(WIN.start)}`);
    expect(fb).toContain(`until=${encodeURIComponent(WIN.end)}`);
    expect(fb).toContain('per_page=100');
    expect(r.facts!.commits).toHaveLength(2); // c is after window end
    for (const c of r.facts!.commits) {
      expect(c.files).toBeNull();
      expect(c.additions).toBeNull();
    }
    expect(r.facts!.headSha).toBe('cccc000000000000000000000000000000000003');
    expect(m.log).toHaveLength(4); // no per-commit fetches
  });

  it('no prevHeadSha -> commits?sha=&since= instead of compare (still 3 calls)', async () => {
    const m = mock(ghRoutes([[/\/commits\?/, () => res(JSON.stringify(json('github/compare.json').commits))]]));
    const r = await checkRepo(REF, WIN, null, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(m.urls().some((u) => u.includes('/compare/'))).toBe(false);
    expect(m.urls()[1]).toContain('/commits?sha=main');
    expect(r.calls).toBe(3);
    expect(r.facts!.commits[0].files).toBeNull();
  });

  it('304 on meta -> no compare, only releases, reuses prev head', async () => {
    const m = mock(ghRoutes([[META_RE, () => res('', 304)]]));
    const d = await checkRepoDetailed(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways, prevEtag: 'W/"abc"' });
    expect(m.urls().some((u) => u.includes('/compare/'))).toBe(false);
    expect(d.result.calls).toBe(2);
    expect(d.result.facts!.headSha).toBe(PREV);
    expect(d.result.facts!.commits).toEqual([]);
    expect(d.etag).toBe('W/"abc"');
  });

  it('pushed_at before window start -> no compare', async () => {
    const m = mock(ghRoutes([[META_RE, meta('2026-10-30T00:00:00Z')]]));
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(m.urls().some((u) => u.includes('/compare/'))).toBe(false);
    expect(r.calls).toBe(2);
    expect(r.facts!.headSha).toBe(PREV);
  });

  it('budget refused after meta -> commits via atom, degraded', async () => {
    const m = mock([
      ...ghRoutes(),
      [/commits\/main\.atom/, () => res(fx('github/commits.atom'))],
      [/releases\.atom/, () => res(fx('github/releases-entries.atom'))],
    ]);
    let n = 0;
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: async () => ++n <= 1 });
    expect(r.degraded).toBe(true);
    expect(r.calls).toBe(1);
    expect(m.urls().some((u) => u.includes('/compare/'))).toBe(false);
    expect(r.facts!.mode).toBe('atom');
  });

  it('403/429 on meta -> atom fallback, degraded', async () => {
    for (const status of [403, 429]) {
      const m = mock([
        [/api\.github\.com/, () => res('{"message":"rate limit"}', status)],
        [/commits\/.*\.atom/, () => res(fx('github/commits.atom'))],
        [/releases\.atom/, () => res(fx('github/releases-entries.atom'))],
      ]);
      const r = await checkRepo({ ...REF, branch: 'master' }, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
      expect(r.ok).toBe(true);
      expect(r.degraded).toBe(true);
      expect(r.facts!.mode).toBe('atom');
      expect(r.calls).toBe(1);
    }
  });

  it('repo 404 -> ok:false', async () => {
    const m = mock([[/api\.github\.com/, () => res('{}', 404)]]);
    const r = await checkRepo(REF, WIN, PREV, { fetch: m.fetch, token: 't', budget: budgetAlways });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('fetch throwing (BlockedUrl or otherwise) never throws out of the adapter', async () => {
    for (const err of [new BlockedUrl('nope'), new Error('boom')]) {
      const r = await checkRepo(REF, WIN, PREV, {
        fetch: async () => {
          throw err;
        },
        token: 't',
        budget: budgetAlways,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(err.message);
      expect(r.source).toBe('repo');
    }
  });
});

describe('atom path', () => {
  const atomRoutes: Route[] = [
    [/commits\/master\.atom/, () => res(fx('github/commits.atom'))],
    [/releases\.atom/, () => res(fx('github/releases-entries.atom'))],
  ];
  const W = { start: '2026-11-05T00:00:00.000Z', end: '2026-11-06T00:00:00.000Z' };

  it('budget refused -> atom mode, degraded true, files null, no REST', async () => {
    const m = mock(atomRoutes);
    const r = await checkRepo({ ...REF, branch: 'master' }, W, PREV, { fetch: m.fetch, token: 't', budget: async () => false });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.calls).toBe(0);
    expect(m.urls().every((u) => u.startsWith('https://github.com/'))).toBe(true);
    const f = r.facts!;
    expect(f.mode).toBe('atom');
    expect(f.commits).toHaveLength(1);
    expect(f.commits[0].sha).toBe('f9baa19408004355473b2771c002df94f8a0ba9e');
    expect(f.commits[0].files).toBeNull();
    expect(f.commits[0].additions).toBeNull();
    expect(f.commits[0].author).toBe('rkalis');
    expect(f.commits[0].message).toBe('fix: fix Etherlink and Citrea event indexing and remove Matchain (#318)');
    expect(f.commits[0].kind).toBe('code');
    expect(f.headSha).toBe('f9baa19408004355473b2771c002df94f8a0ba9e');
    expect(f.releases).toEqual([]);
  });

  it('no token -> atom directly with zero REST and zero budget calls; releases parsed', async () => {
    const m = mock(atomRoutes);
    let budgetCalls = 0;
    const r = await checkRepo({ ...REF, branch: 'master' }, WIN, null, {
      fetch: m.fetch,
      budget: async () => (budgetCalls++, true),
    });
    expect(budgetCalls).toBe(0);
    expect(m.urls().some((u) => u.includes('api.github.com'))).toBe(false);
    expect(r.facts!.mode).toBe('atom');
    expect(r.facts!.headSha).toBe('f9baa19408004355473b2771c002df94f8a0ba9e');
    const W2 = { start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z' };
    const r2 = await checkRepo({ ...REF, branch: 'master' }, W2, null, { fetch: m.fetch });
    expect(r2.facts!.releases).toEqual([
      { tag: 'v2.4.0', name: 'Matchain support', date: '2026-11-04T13:05:00Z', url: 'https://github.com/RevokeCash/revoke.cash/releases/tag/v2.4.0' },
    ]);
    expect(r2.facts!.commits).toEqual([]);
  });

  it('commits outside window excluded in atom (by updated)', async () => {
    const m = mock(atomRoutes);
    const Wold = { start: '2026-11-03T00:00:00.000Z', end: '2026-11-04T00:00:00.000Z' };
    const r = await checkRepo({ ...REF, branch: 'master' }, Wold, null, { fetch: m.fetch });
    const shas = r.facts!.commits.map((c) => c.sha);
    expect(shas).not.toContain('f9baa19408004355473b2771c002df94f8a0ba9e');
    expect(shas).toContain('4775ef5f48187a7b8faae8056396075cb7ec7701');
    for (const c of r.facts!.commits) expect(c.date >= Wold.start && c.date < Wold.end).toBe(true);
  });

  it('hostile XML (DOCTYPE entities) is not expanded', async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;">]><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Grit::Commit/${'a'.repeat(40)}</id><updated>2026-11-05T01:00:00Z</updated><title>&b;</title><author><name>x</name></author></entry></feed>`;
    const m = mock([
      [/commits/, () => res(evil)],
      [/releases/, () => res('<feed/>')],
    ]);
    const r = await checkRepo({ ...REF, branch: 'master' }, W, null, { fetch: m.fetch });
    expect(r.ok).toBe(true);
    for (const c of r.facts!.commits) expect(c.message).not.toContain('AAAAAAAAAA');
  });
});

describe('gitlab', () => {
  const GL = { host: 'gitlab' as const, repo: 'acme/widget', branch: 'main' };
  const W = { start: '2026-11-04T00:00:00.000Z', end: '2026-11-06T00:00:00.000Z' };
  const routes: Route[] = [
    [/repository\/commits\?/, () => res(fx('gitlab/commits.json'))],
    [/repository\/compare\?/, () => res(fx('gitlab/compare.json'))],
    [/\/releases/, () => res(fx('gitlab/releases.json'))],
  ];

  it('stats parsed, window filtered by authored_date, urls encoded, budget per call', async () => {
    const m = mock(routes);
    const spent: number[] = [];
    const r = await checkRepo(GL, W, PREV, { fetch: m.fetch, budget: async (n) => (spent.push(n), true) });
    expect(r.ok).toBe(true);
    const u0 = m.urls()[0];
    expect(u0).toContain('https://gitlab.com/api/v4/projects/acme%2Fwidget/repository/commits?');
    expect(u0).toContain('ref_name=main');
    expect(u0).toContain('with_stats=true');
    expect(u0).toContain('per_page=100');
    expect(u0).toContain('since=');
    expect(m.urls()[1]).toContain(`repository/compare?from=${PREV}&to=main`);
    expect(spent).toEqual([1, 1, 1]);
    expect(r.calls).toBe(3);
    const f = r.facts!;
    expect(f.host).toBe('gitlab');
    expect(f.commits.map((c) => c.sha[0])).toEqual(['1', '2']); // 3333 authored Oct 1 excluded
    expect(f.commits[0].additions).toBe(120);
    expect(f.commits[0].deletions).toBe(8);
    expect(f.commits[1].additions).toBe(4);
    expect(f.headSha).toBe('1111111111111111111111111111111111111111');
    expect(f.releases.map((x) => x.tag)).toEqual(['v0.3.0']);
    expect(f.releases[0].url).toBe('https://gitlab.com/acme/widget/-/releases/v0.3.0');
    expect(f.commits.every((c) => c.authorIsBot === false)).toBe(true);
  });

  it('budget refused -> ok:false degraded (no atom for gitlab)', async () => {
    const m = mock(routes);
    const r = await checkRepo(GL, W, null, { fetch: m.fetch, budget: async () => false });
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(m.log).toHaveLength(0);
  });

  it('compare 404 -> commits kept with null files, degraded', async () => {
    const m = mock([[/repository\/compare\?/, () => res('{}', 404)], ...routes]);
    const r = await checkRepo(GL, W, PREV, { fetch: m.fetch });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.facts!.commits[0].files).toBeNull();
    expect(r.facts!.commits[0].additions).toBe(120);
  });
});
