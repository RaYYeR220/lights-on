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

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** GitHub: exactly owner/name. GitLab: 2-5 segments (nested groups). No `.`/`..` segments. Segments are URL-safe by construction. */
export function validRepo(ref: RepoRef): boolean {
  if (typeof ref.repo !== 'string') return false;
  const parts = ref.repo.split('/');
  const max = ref.host === 'gitlab' ? 5 : 2;
  if (parts.length < 2 || parts.length > max) return false;
  return parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
}

/** Like checkRepo, but also returns the ETag to store for the next night's conditional meta request. */
export async function checkRepoDetailed(
  ref: RepoRef,
  window: TimeWindow,
  prevHeadSha: string | null,
  deps: RepoDeps = {},
): Promise<{ result: AdapterResult<RepoFacts>; etag: string | null }> {
  if (!validRepo(ref)) {
    return { result: { source: 'repo', tier: 'verified', ok: false, facts: null, error: 'invalid_repo' }, etag: deps.prevEtag ?? null };
  }
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
