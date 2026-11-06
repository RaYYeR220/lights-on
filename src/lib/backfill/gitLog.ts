import { makeCommit } from '@/lib/adapters/repoCommon';
import { hashEvidence, RULES_VERSION } from '@/lib/shift/evidence';
import { decideStatus } from '@/lib/shift/rules';
import { nightDate, nightNumber, nightlyWindow, nightContaining } from '@/lib/shift/night';
import type { CommitFact, Decision, EvidenceBundle, ReleaseFact } from '@/lib/types';

/** `git log --numstat --format=%x1e%H%x1f%an%x1f%aI%x1f%s` */
export const GIT_LOG_FORMAT = '%x1e%H%x1f%an%x1f%aI%x1f%s';

/** New path of a numstat rename: `a => b` or `pre/{a => b}/post` (either side of the braces may be empty). */
export function resolveRenamePath(p: string): string {
  const brace = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(p);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/');
  const plain = / => /.exec(p);
  return plain ? p.slice(plain.index + plain[0].length) : p;
}

export function parseNumstatLog(text: string): CommitFact[] {
  const out: CommitFact[] = [];
  for (const rec of text.split('\x1e')) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const header = nl === -1 ? rec : rec.slice(0, nl);
    const body = nl === -1 ? '' : rec.slice(nl + 1);
    const [sha, author, iso, ...subject] = header.split('\x1f');
    const t = Date.parse(iso ?? '');
    if (!sha || !Number.isFinite(t)) continue;

    const files: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of body.split(/\r?\n/)) {
      if (!line) continue;
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      if (m[1] !== '-') additions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
      files.push(resolveRenamePath(m[3]));
    }
    out.push(makeCommit({
      sha,
      author: author ?? '',
      date: new Date(t).toISOString(),
      message: subject.join('\x1f'),
      // merges / empty commits list no files: unknown, so classify by message instead of defaulting to 'code'
      files: files.length ? files : null,
      additions: files.length ? additions : null,
      deletions: files.length ? deletions : null,
    }));
  }
  return out;
}

export function bucketByNight<T extends { date: string }>(items: T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const it of items) {
    const n = nightContaining(new Date(it.date));
    const arr = m.get(n);
    if (arr) arr.push(it);
    else m.set(n, [it]);
  }
  return m;
}

export interface BackfillNight {
  night: number; // yyyymmdd
  date: string; // yyyy-mm-dd
  bundle: EvidenceBundle;
  hash: string;
  decision: Decision;
}

/** Repo-only nightly bundles for the `days` nights ending at `shiftStart` (night k back has shiftStart - (k-1) days). */
export function buildRepoNights(p: {
  slug: string;
  host: 'github' | 'gitlab';
  repo: string;
  branch: string;
  commits: CommitFact[];
  releases: ReleaseFact[];
  shiftStart: Date; // today's 05:00 UTC
  days: number;
}): BackfillNight[] {
  const commits = bucketByNight(p.commits);
  const releases = bucketByNight(p.releases);
  const res: BackfillNight[] = [];
  for (let k = 1; k <= p.days; k++) {
    const start = new Date(p.shiftStart.getTime() - (k - 1) * 86_400_000);
    const night = nightNumber(start);
    const bundle: EvidenceBundle = {
      v: 1,
      rulesVersion: RULES_VERSION,
      project: p.slug,
      night,
      kind: 'nightly',
      window: nightlyWindow(start),
      sources: {
        repo: {
          source: 'repo',
          tier: 'verified',
          ok: true,
          facts: {
            host: p.host, repo: p.repo, branch: p.branch, headSha: null, mode: 'git',
            commits: (commits.get(night) ?? []).sort((a, b) => a.date.localeCompare(b.date) || a.sha.localeCompare(b.sha)),
            releases: (releases.get(night) ?? []).sort((a, b) => a.tag.localeCompare(b.tag)),
          },
        },
        liveapp: null,
        chain: null,
        vibestarter: null,
      },
    };
    res.push({ night, date: nightDate(night), bundle, hash: hashEvidence(bundle), decision: decideStatus(bundle) });
  }
  return res;
}
