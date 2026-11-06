import type { Decision, EvidenceBundle, Record30, SourceName, Status } from '@/lib/types';

/** Verified-tier reason codes, in the order they are emitted. */
export const REASONS = [
  'liveapp.new_deploy',
  'repo.release',
  'chain.new_deployment',
  'repo.code_commits',
  'liveapp.down',
  'all.unavailable',
  'none',
] as const;

/** Informational reasons appended after the verdict reasons. */
export const NOTE_REASONS = [
  'liveapp.blocked',
  'source.repo.failed',
  'source.liveapp.failed',
  'source.chain.failed',
  'source.vibestarter.failed',
] as const;

/** Human-readable rules, one sentence each. Shown verbatim on /methodology. Keep in sync with decideStatus. */
export const RULES_TEXT: string[] = [
  'Each night covers the 24 hours ending at the shift time, and only verified evidence (what we observed ourselves) decides the status.',
  'Shipped: the live app has a new deployment (liveapp.new_deploy), or the repo published a release or tag in the window (repo.release), or a listed deployer created a contract (chain.new_deployment).',
  'Building: not shipped, and at least one commit by a non-bot author touched code rather than only docs, styling or config (repo.code_commits).',
  'Down: the live app failed twice in a row (a non-2xx/3xx response or a timeout) and nothing else shipped that night (liveapp.down).',
  'Quiet: none of the above - the app is not known to be down and no verified change was seen (none).',
  'Unavailable: none of the repo, live app or chain answered, or none of them applies to the project, so we make no claim either way (all.unavailable).',
  'Precedence is shipped, then building, then down, then quiet; unavailable applies only when none of repo, live app or chain answered.',
  'A site that answers 401, 403 or 429 is blocking our check, not down; we note it as liveapp.blocked and it never counts as down.',
  'A source that fails while others succeed is noted as source.<name>.failed and the status is decided from the rest.',
  'Vibestarter records never count toward any status; founder updates, Vibestarter activity feeds and contract usage counts are reported or informational and never make a night shipped or building.',
  'Streak is the run of consecutive shipped or building nights ending at the latest night; unavailable or missing nights neither extend nor break it, while quiet and down nights end it.',
  'Lit30 is the number of shipped or building nights among the 30 calendar nights ending today, and last ship is the latest night with status shipped.',
  'An AI model may explain a night afterwards but can never change its status.',
];

const BLOCKED_PREFIX = 'blocked_by_site';
const SOURCE_ORDER: SourceName[] = ['repo', 'liveapp', 'chain', 'vibestarter'];

export function decideStatus(b: EvidenceBundle): Decision {
  const present = SOURCE_ORDER.flatMap((name) => {
    const s = b.sources[name];
    return s ? [{ name, ok: s.ok, error: s.error }] : [];
  });
  const failedInfo = present
    .filter((s) => !s.ok)
    .map((s) =>
      s.name === 'liveapp' && s.error?.startsWith(BLOCKED_PREFIX) ? 'liveapp.blocked' : `source.${s.name}.failed`,
    );

  const bearing = present.filter((s) => s.name !== 'vibestarter');
  if (bearing.length === 0 || bearing.every((s) => !s.ok)) {
    return { status: 'unavailable', reasons: ['all.unavailable', ...failedInfo] };
  }

  const live = b.sources.liveapp;
  const repo = b.sources.repo;
  const chain = b.sources.chain;
  const liveFacts = live?.ok ? live.facts : null;
  const repoFacts = repo?.ok ? repo.facts : null;
  const chainFacts = chain?.ok ? chain.facts : null;

  const newDeploy = liveFacts?.newDeploy === true;
  const release = (repoFacts?.releases.length ?? 0) > 0;
  const newContract = (chainFacts?.newDeployments.length ?? 0) > 0;
  const codeCommits = (repoFacts?.commits ?? []).some((c) => c.kind === 'code' && !c.authorIsBot);
  const down = liveFacts !== null && liveFacts.up === false;

  const reasons: string[] = [];
  if (newDeploy) reasons.push('liveapp.new_deploy');
  if (release) reasons.push('repo.release');
  if (newContract) reasons.push('chain.new_deployment');
  if (codeCommits) reasons.push('repo.code_commits');
  if (down) reasons.push('liveapp.down');

  const status: Status =
    newDeploy || release || newContract ? 'shipped' : codeCommits ? 'building' : down ? 'down' : 'quiet';
  if (reasons.length === 0) reasons.push('none');
  return { status, reasons: [...reasons, ...failedInfo] };
}

// ---- record ----

function toDays(night: number): number {
  const y = Math.floor(night / 10000);
  const m = Math.floor((night % 10000) / 100);
  const d = night % 100;
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

const isLit = (s: Status) => s === 'shipped' || s === 'building';

export function computeRecord(nights: { night: number; status: Status }[], today: number): Record30 {
  const byNight = new Map<number, Status>();
  for (const n of nights) if (n.night <= today) byNight.set(n.night, n.status);
  const sorted = [...byNight.entries()].sort((a, b) => b[0] - a[0]); // newest first

  let streak = 0;
  for (const [, status] of sorted) {
    if (status === 'unavailable') continue;
    if (!isLit(status)) break;
    streak++;
  }

  const todayDay = toDays(today);
  let lit30 = 0;
  let lastShip: number | null = null;
  for (const [night, status] of sorted) {
    if (isLit(status) && todayDay - toDays(night) < 30) lit30++;
    if (status === 'shipped' && lastShip === null) lastShip = night;
  }
  return { streak, lit30, lastShip };
}
