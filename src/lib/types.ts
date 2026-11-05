export type Status = 'shipped'|'building'|'quiet'|'down'|'unavailable';
export const STATUS_CODE: Record<Status, 1|2|3|4|5> = {
  shipped: 1,
  building: 2,
  quiet: 3,
  down: 4,
  unavailable: 5,
};
export type Kind = 'nightly'|'live';
export type SourceName = 'repo'|'liveapp'|'chain'|'vibestarter';
export type Tier = 'verified'|'reported';
export interface TimeWindow { start: string; end: string }            // ISO
export interface AdapterResult<F> { source: SourceName; tier: Tier; ok: boolean; degraded?: boolean; facts: F|null; error?: string; calls?: number }
export interface CommitFact { sha: string; author: string; authorIsBot: boolean; date: string; message: string; files: string[]|null; additions: number|null; deletions: number|null; kind: 'code'|'cosmetic' }
export interface ReleaseFact { tag: string; name: string|null; date: string; url: string }
export interface RepoFacts { host: 'github'|'gitlab'; repo: string; branch: string; headSha: string|null; mode: 'api'|'atom'|'git'; commits: CommitFact[]; releases: ReleaseFact[] }
export interface LiveAppFacts { url: string; finalUrl: string|null; httpStatus: number|null; up: boolean; latencyMs: number|null; deployFingerprint: string|null; textHash: string|null; title: string|null; bytes: number|null; newDeploy: boolean; textDelta: { added: string[]; removed: string[]; changedChars: number }|null }
export interface ChainFacts { contracts: { chainId: number; address: string; txCount: number; uniqueSenders: number }[]; newDeployments: { address: string; txHash: string; at: string }[]; holderDelta: number|null }
export interface TrancheFact { index: number; status: string; requestedAt: string|null; windowEndsAt: string|null; amountPaidWei: string|null }
export interface VibestarterFacts { campaignId: string; raiseStatus: string; tranches: TrancheFact[]; openWindow: TrancheFact|null; founderUpdates: { cid: string; at: string }[]; reportedActivity: { type: string; summary: string; at: string }[] }
export interface EvidenceBundle { v: 1; rulesVersion: string; project: string; night: number; kind: Kind; window: TimeWindow; sources: { repo: AdapterResult<RepoFacts>|null; liveapp: AdapterResult<LiveAppFacts>|null; chain: AdapterResult<ChainFacts>|null; vibestarter: AdapterResult<VibestarterFacts>|null } }
export interface Decision { status: Status; reasons: string[] }        // reasons: stable machine strings, e.g. 'liveapp.new_deploy'
export interface Record30 { streak: number; lit30: number; lastShip: number|null }
export interface Step { at: string; key: string; label: string; state: 'start'|'ok'|'warn'|'fail'; detail?: string }
