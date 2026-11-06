import { safeFetch } from '@/lib/net/safeFetch';
import type { AdapterResult, RepoFacts, TimeWindow } from '@/lib/types';
import { checkGithub } from './github';
import { checkGitlab } from './gitlab';
import { errMsg, type FetchLike, type RepoDeps, type RepoRef, type ResolvedDeps } from './repoCommon';

export { classifyPaths, classifyMessage, isBot } from './pathHeuristic';
export type { RepoDeps, RepoRef, FetchLike } from './repoCommon';

function resolve(deps: RepoDeps): ResolvedDeps {
  const fetch: FetchLike = deps.fetch ?? ((url, init) => safeFetch(url, init));
  return { fetch, budget: deps.budget ?? (async () => true), token: deps.token, prevEtag: deps.prevEtag };
}

/** Like checkRepo, but also returns the ETag to store for the next night's conditional meta request. */
export async function checkRepoDetailed(
  ref: RepoRef,
  window: TimeWindow,
  prevHeadSha: string | null,
  deps: RepoDeps = {},
): Promise<{ result: AdapterResult<RepoFacts>; etag: string | null }> {
  try {
    const d = resolve(deps);
    if (ref.host === 'gitlab') return { result: await checkGitlab(ref, window, prevHeadSha, d), etag: null };
    return await checkGithub(ref, window, prevHeadSha, d);
  } catch (e) {
    return { result: { source: 'repo', tier: 'verified', ok: false, facts: null, error: errMsg(e) }, etag: deps.prevEtag ?? null };
  }
}

export async function checkRepo(
  ref: RepoRef,
  window: TimeWindow,
  prevHeadSha: string | null,
  deps: RepoDeps = {},
): Promise<AdapterResult<RepoFacts>> {
  return (await checkRepoDetailed(ref, window, prevHeadSha, deps)).result;
}
