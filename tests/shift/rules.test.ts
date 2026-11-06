import { describe, it, expect } from 'vitest';
import { decideStatus, computeRecord, RULES_TEXT, REASONS, NOTE_REASONS } from '@/lib/shift/rules';
import type { EvidenceBundle, AdapterResult, LiveAppFacts, RepoFacts, ChainFacts, VibestarterFacts, CommitFact, Status, SourceName } from '@/lib/types';

const live = (o: Partial<LiveAppFacts> = {}): AdapterResult<LiveAppFacts> => ({
  source: 'liveapp', tier: 'verified', ok: true,
  facts: { url: 'https://x.app', finalUrl: null, httpStatus: 200, up: true, latencyMs: 100, deployFingerprint: 'a', textHash: 'h', title: 't', bytes: 10, newDeploy: false, textDelta: null, ...o },
});
const commit = (o: Partial<CommitFact> = {}): CommitFact => ({ sha: 's', author: 'a', authorIsBot: false, date: '2026-11-05T10:00:00Z', message: 'm', files: ['src/a.ts'], additions: 1, deletions: 0, kind: 'code', ...o });
const repo = (o: Partial<RepoFacts> = {}): AdapterResult<RepoFacts> => ({
  source: 'repo', tier: 'verified', ok: true,
  facts: { host: 'github', repo: 'o/r', branch: 'main', headSha: 'x', mode: 'api', commits: [], releases: [], ...o },
});
const chain = (o: Partial<ChainFacts> = {}): AdapterResult<ChainFacts> => ({
  source: 'chain', tier: 'verified', ok: true,
  facts: { contracts: [], newDeployments: [], holderDelta: null, ...o },
});
const vs = (o: Partial<VibestarterFacts> = {}): AdapterResult<VibestarterFacts> => ({
  source: 'vibestarter', tier: 'reported', ok: true,
  facts: { campaignId: '1', raiseStatus: 'x', tranches: [], openWindow: null, founderUpdates: [{ cid: 'c', at: '2026-11-05T00:00:00Z' }], reportedActivity: [{ type: 'update', summary: 's', at: '2026-11-05T00:00:00Z' }], ...o },
});
function failed<F>(source: SourceName, error = 'network', degraded?: boolean): AdapterResult<F> {
  return { source, tier: 'verified', ok: false, facts: null, error, ...(degraded ? { degraded } : {}) };
}

const bundle = (s: Partial<EvidenceBundle['sources']>): EvidenceBundle => ({
  v: 1, rulesVersion: 'r1', project: 'p', night: 20261105, kind: 'nightly',
  window: { start: '2026-11-04T00:00:00Z', end: '2026-11-05T00:00:00Z' },
  sources: { repo: null, liveapp: null, chain: null, vibestarter: null, ...s },
});

const release = { tag: 'v1', name: null, date: 'd', url: 'u' };
const deployed = { address: '0x1', txHash: '0x2', at: 'a' };

describe('decideStatus', () => {
  const cases: [string, Partial<EvidenceBundle['sources']>, Status, string[]][] = [
    ['new deploy on live app', { liveapp: live({ newDeploy: true }) }, 'shipped', ['liveapp.new_deploy']],
    ['release in window', { liveapp: live(), repo: repo({ releases: [release] }) }, 'shipped', ['repo.release']],
    ['release wins over cosmetic-only repo', { repo: repo({ commits: [commit({ kind: 'cosmetic' })], releases: [release] }) }, 'shipped', ['repo.release']],
    ['contract creation', { chain: chain({ newDeployments: [deployed] }) }, 'shipped', ['chain.new_deployment']],
    ['all three ship signals, deterministic order', {
      chain: chain({ newDeployments: [deployed] }),
      repo: repo({ releases: [release] }),
      liveapp: live({ newDeploy: true }),
    }, 'shipped', ['liveapp.new_deploy', 'repo.release', 'chain.new_deployment']],
    ['shipped plus code commits lists both', { liveapp: live({ newDeploy: true }), repo: repo({ commits: [commit()] }) }, 'shipped', ['liveapp.new_deploy', 'repo.code_commits']],
    ['non-bot code commit builds', { liveapp: live(), repo: repo({ commits: [commit()] }) }, 'building', ['repo.code_commits']],
    ['bot-only code commits are quiet', { liveapp: live(), repo: repo({ commits: [commit({ authorIsBot: true })] }) }, 'quiet', ['none']],
    ['cosmetic-only commits are quiet', { liveapp: live(), repo: repo({ commits: [commit({ kind: 'cosmetic' })] }) }, 'quiet', ['none']],
    ['bot code + human cosmetic is quiet', { repo: repo({ commits: [commit({ authorIsBot: true }), commit({ kind: 'cosmetic' })] }) }, 'quiet', ['none']],
    ['bot + human code commit builds', { repo: repo({ commits: [commit({ authorIsBot: true }), commit()] }) }, 'building', ['repo.code_commits']],
    ['up, nothing changed', { liveapp: live(), repo: repo(), chain: chain() }, 'quiet', ['none']],
    ['contract txCount alone is not a ship', { chain: chain({ contracts: [{ chainId: 8453, address: '0x1', txCount: 999, uniqueSenders: 50 }] }) }, 'quiet', ['none']],
    ['founder-reported activity alone is quiet', { liveapp: live(), vibestarter: vs() }, 'quiet', ['none']],
    ['vibestarter alone with reports is unavailable', { vibestarter: vs() }, 'unavailable', ['all.unavailable']],
    ['site down, nothing shipped', { liveapp: live({ up: false, httpStatus: 500 }) }, 'down', ['liveapp.down']],
    ['site down + only cosmetic commits', { liveapp: live({ up: false }), repo: repo({ commits: [commit({ kind: 'cosmetic' })] }) }, 'down', ['liveapp.down']],
    ['site down but code commits -> building', { liveapp: live({ up: false }), repo: repo({ commits: [commit()] }) }, 'building', ['repo.code_commits', 'liveapp.down']],
    ['site down but release -> shipped', { liveapp: live({ up: false }), repo: repo({ releases: [release] }) }, 'shipped', ['repo.release', 'liveapp.down']],
    ['site down but contract deployed -> shipped', { liveapp: live({ up: false }), chain: chain({ newDeployments: [deployed] }) }, 'shipped', ['chain.new_deployment', 'liveapp.down']],
    ['blocked live app is not down', { liveapp: failed('liveapp', 'blocked_by_site (403)', true), repo: repo() }, 'quiet', ['none', 'liveapp.blocked']],
    ['blocked live app alone is unavailable', { liveapp: failed('liveapp', 'blocked_by_site (429)', true) }, 'unavailable', ['all.unavailable', 'liveapp.blocked']],
    ['failed repo does not hide a deploy', { liveapp: live({ newDeploy: true }), repo: failed('repo', 'invalid_repo') }, 'shipped', ['liveapp.new_deploy', 'source.repo.failed']],
    ['failed live app + quiet repo is quiet, not down', { liveapp: failed('liveapp', 'network'), repo: repo() }, 'quiet', ['none', 'source.liveapp.failed']],
    ['null sources are ignored', { liveapp: live() }, 'quiet', ['none']],
    ['all present failed -> unavailable', { liveapp: failed('liveapp'), repo: failed('repo', 'invalid_repo'), chain: failed('chain', 'x', true) }, 'unavailable', ['all.unavailable', 'source.repo.failed', 'source.liveapp.failed', 'source.chain.failed']],
    ['failed live app + ok vibestarter is unavailable', { liveapp: failed('liveapp'), vibestarter: vs() }, 'unavailable', ['all.unavailable', 'source.liveapp.failed']],
    ['failed live app + failed vibestarter -> unavailable', { liveapp: failed('liveapp'), vibestarter: failed('vibestarter') }, 'unavailable', ['all.unavailable', 'source.liveapp.failed', 'source.vibestarter.failed']],
  ];
  it.each(cases)('%s', (_n, sources, status, reasons) => {
    expect(decideStatus(bundle(sources))).toEqual({ status, reasons });
  });

  it('no sources at all -> unavailable', () => {
    expect(decideStatus(bundle({}))).toEqual({ status: 'unavailable', reasons: ['all.unavailable'] });
  });
});

describe('RULES_TEXT', () => {
  it('mentions every reason code', () => {
    const text = RULES_TEXT.join('\n');
    for (const code of REASONS) expect(text, code).toContain(code);
    for (const code of NOTE_REASONS.filter((c) => !c.startsWith('source.'))) expect(text, code).toContain(code);
    expect(text).toContain('source.<name>.failed');
    for (const name of ['repo', 'liveapp', 'chain', 'vibestarter']) expect(NOTE_REASONS).toContain(`source.${name}.failed`);
    expect(RULES_TEXT.every((s) => s.trim().length > 0)).toBe(true);
  });
});

describe('computeRecord', () => {
  const n = (night: number, status: Status) => ({ night, status });
  it('empty', () => expect(computeRecord([], 20261105)).toEqual({ streak: 0, lit30: 0, lastShip: null }));
  it('streak across unavailable night', () => {
    const r = computeRecord([n(20261103, 'shipped'), n(20261104, 'unavailable'), n(20261105, 'building')], 20261105);
    expect(r).toEqual({ streak: 2, lit30: 2, lastShip: 20261103 });
  });
  it('quiet breaks streak', () => {
    expect(computeRecord([n(20261103, 'shipped'), n(20261104, 'quiet'), n(20261105, 'building')], 20261105).streak).toBe(1);
  });
  it('down breaks streak', () => {
    expect(computeRecord([n(20261103, 'shipped'), n(20261104, 'down'), n(20261105, 'shipped')], 20261105).streak).toBe(1);
  });
  it('latest night quiet -> streak 0', () => {
    expect(computeRecord([n(20261104, 'shipped'), n(20261105, 'quiet')], 20261105).streak).toBe(0);
  });
  it('missing nights are skipped like unavailable', () => {
    expect(computeRecord([n(20261101, 'shipped'), n(20261105, 'shipped')], 20261105).streak).toBe(2);
  });
  it('lastShip ignores building, picks latest shipped', () => {
    const r = computeRecord([n(20261101, 'shipped'), n(20261102, 'shipped'), n(20261104, 'building')], 20261105);
    expect(r.lastShip).toBe(20261102);
  });
  it('lastShip null when only building', () => {
    expect(computeRecord([n(20261104, 'building')], 20261105).lastShip).toBeNull();
  });
  it('nights after today are ignored', () => {
    const r = computeRecord([n(20261104, 'shipped'), n(20261106, 'shipped')], 20261105);
    expect(r).toEqual({ streak: 1, lit30: 1, lastShip: 20261104 });
  });
  it('streak ends at latest night <= today even if today has no row', () => {
    expect(computeRecord([n(20261102, 'shipped'), n(20261103, 'shipped')], 20261105).streak).toBe(2);
  });
  it('lit30 window edges: 30 nights inclusive of today', () => {
    // today 2026-11-05: window = 2026-10-07 .. 2026-11-05
    const r = computeRecord([n(20261006, 'shipped'), n(20261007, 'shipped'), n(20261105, 'building')], 20261105);
    expect(r.lit30).toBe(2);
    expect(r.lastShip).toBe(20261007);
  });
  it('lit30 across month/year boundary and leap day', () => {
    // today 2028-03-01: window starts 2028-02-01 (Feb 2028 has 29 days)
    const r = computeRecord([n(20280131, 'shipped'), n(20280201, 'shipped'), n(20280301, 'shipped')], 20280301);
    expect(r.lit30).toBe(2);
    // today 2027-01-10: window starts 2026-12-12
    const r2 = computeRecord([n(20261211, 'shipped'), n(20261212, 'shipped')], 20270110);
    expect(r2.lit30).toBe(1);
  });
  it('quiet/down/unavailable do not count toward lit30', () => {
    expect(computeRecord([n(20261103, 'quiet'), n(20261104, 'down'), n(20261105, 'unavailable')], 20261105).lit30).toBe(0);
  });
  it('duplicate night rows: last wins', () => {
    expect(computeRecord([n(20261105, 'quiet'), n(20261105, 'shipped')], 20261105).lit30).toBe(1);
  });
  it('unsorted input', () => {
    expect(computeRecord([n(20261105, 'shipped'), n(20261103, 'shipped'), n(20261104, 'shipped')], 20261105).streak).toBe(3);
  });
});
