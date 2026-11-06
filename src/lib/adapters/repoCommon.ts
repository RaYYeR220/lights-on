import { safeErrorCode } from '@/lib/net/redact';
import type { SafeFetchResult } from '@/lib/net/safeFetch';
import type { CommitFact, TimeWindow } from '@/lib/types';
import { classifyMessage, classifyPaths, isBot } from './pathHeuristic';

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<SafeFetchResult>;

export interface RepoRef {
  host: 'github' | 'gitlab';
  repo: string; // owner/name
  branch?: string;
}

export interface RepoDeps {
  fetch?: FetchLike;
  token?: string;
  /** Called with n=1 BEFORE every REST call; false -> stop REST. Defaults to always-allow. */
  budget?: (n: number) => Promise<boolean>;
  /** Stored ETag of the GitHub repo-meta response. */
  prevEtag?: string | null;
}

export type ResolvedDeps = Required<Pick<RepoDeps, 'fetch' | 'budget'>> & Pick<RepoDeps, 'token' | 'prevEtag'>;

export function inWindow(iso: string, w: TimeWindow): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.parse(w.start) && t < Date.parse(w.end);
}

const MAX_MESSAGE = 500;

export function makeCommit(p: {
  sha: string;
  author: string;
  date: string;
  message: string;
  files?: string[] | null;
  additions?: number | null;
  deletions?: number | null;
}): CommitFact {
  const message = p.message.trim().slice(0, MAX_MESSAGE);
  const files = p.files ?? null;
  return {
    sha: p.sha,
    author: p.author,
    authorIsBot: isBot(p.author),
    date: p.date,
    message,
    files,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    kind: files ? classifyPaths(files) : classifyMessage(message),
  };
}

/**
 * Compare endpoints return only an aggregate file list for the whole range. Attribution:
 *  - exactly one commit -> that commit owns the files and stats;
 *  - several -> per-commit files stay null, but an all-cosmetic aggregate soundly makes every commit cosmetic.
 */
export function applyAggregate(commits: CommitFact[], files: string[], additions: number, deletions: number): CommitFact[] {
  if (commits.length === 1) {
    return [{ ...commits[0], files, additions, deletions, kind: classifyPaths(files) }];
  }
  if (commits.length > 1 && classifyPaths(files) === 'cosmetic') {
    return commits.map((c) => ({ ...c, kind: 'cosmetic' as const }));
  }
  return commits;
}

export function errMsg(e: unknown): string {
  return safeErrorCode(e); // fixed code only; messages can embed URLs/keys
}
