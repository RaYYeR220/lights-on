import type { Hex } from 'viem';
import type { Db } from '@/lib/db';
import {
  DuplicateNight, getLastSnapshot, getLatestNightly, getNightlyShift, getNights, getProjectById, getShift,
  insertLiveRun, insertNight, markShiftRunDone, saveEvidence, saveSnapshot, updateLiveRun, upsertTrancheEvents,
} from '@/lib/db/queries';
import type { ProjectRow } from '@/lib/db/schema';
import { safeErrorCode } from '@/lib/net/redact';
import type {
  AdapterResult, ChainFacts, Decision, EvidenceBundle, Kind, LiveAppFacts, RepoFacts, SourceName, Status, Step,
  TimeWindow, VibestarterFacts,
} from '@/lib/types';
import { decideStatus } from './rules';
import { hashEvidence, RULES_VERSION } from './evidence';
import type { Explanation } from './explain';
import { attestDepsFor, canAttest, resolveAdapters, type ShiftDeps } from './deps';
import { finalizeShift, lit30From, lit30Of, toAttestation } from './finalize';
import { nightDate, nightNumber, nightlyWindow, shiftStartOfNight } from './night';

export const STEP_LABELS = {
  load: 'Loading the project…',
  repo: 'Reading the repo…',
  liveapp: 'Checking the live app…',
  chain: 'Reading the chain…',
  vibestarter: 'Reading the Vibestarter campaign…',
  rules: 'Applying the rules…',
  explain: 'Writing the explanation…',
  evidence: 'Sealing the evidence…',
  attest: 'Attesting on Base…',
} as const;
export type StepKey = keyof typeof STEP_LABELS;

export interface RunOptions {
  /** Nightly: the shift this night belongs to (looked up by night when omitted). */
  shiftId?: number;
  /** Live: the row reserved by checkLiveLimit; a new row is inserted when omitted. */
  liveRunId?: number;
  ipHash?: string;
}
/** `txHash` on a skipped outcome = broadcast but not confirmed (or confirmed reverted when error is 'reverted'). */
export type AttestOutcome = { uid: Hex; txHash: Hex } | { skipped: string; error?: string; txHash?: Hex };
export interface RunResult {
  night: number; status: Status; evidenceHash: Hex; nightId?: number; liveRunId?: number; attestation?: AttestOutcome;
}

const MAX_SNAPSHOT_TEXT = 200_000;
/** The live stream should not hang on a slow receipt; the tx is already stored. */
export const LIVE_RECEIPT_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** JSON-safe deep copy: what is hashed is exactly what jsonb stores (NaN -> null, undefined dropped, NUL stripped). */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.replace(/\u0000/g, '') : x)));
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const size = (chars: number) => (chars < 1024 ? `${chars} chars` : `${Math.round(chars / 1024)} KB`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const firstNote = (e?: string) => (e ?? 'error').split(';')[0].slice(0, 60);

function spanLabel(w: TimeWindow): string {
  const ms = Date.parse(w.end) - Date.parse(w.start);
  return ms < 3600_000 ? `last ${Math.max(1, Math.round(ms / 60_000))} min` : `last ${Math.round(ms / 3600_000)} h`;
}

interface Prev {
  live: { facts: LiveAppFacts; text: string | null } | null;
  repo: { headSha: string | null; etag: string | null } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function loadPrev(db: Db, projectId: number): Promise<Prev> {
  const [ls, rs] = await Promise.all([getLastSnapshot(db, projectId, 'liveapp'), getLastSnapshot(db, projectId, 'repo')]);
  const ld = ls?.data;
  const rd = rs?.data;
  return {
    live: isObj(ld) && isObj(ld.facts)
      ? { facts: ld.facts as unknown as LiveAppFacts, text: typeof ld.text === 'string' ? ld.text : null }
      : null,
    repo: isObj(rd)
      ? { headSha: typeof rd.headSha === 'string' ? rd.headSha : null, etag: typeof rd.etag === 'string' ? rd.etag : null }
      : null,
  };
}

type Sources = EvidenceBundle['sources'];
type AnyResult = AdapterResult<unknown>;

function stateOf(name: SourceName, r: AnyResult): Step['state'] {
  if (!r.ok) return name === 'liveapp' && r.error?.startsWith('blocked_by_site') ? 'warn' : 'fail';
  if (r.degraded) return 'warn';
  if (name === 'liveapp' && (r.facts as LiveAppFacts | null)?.up === false) return 'warn';
  return 'ok';
}

function detailOf(name: SourceName, r: AnyResult, hadPrev: boolean): string {
  if (!r.ok) {
    if (name === 'liveapp' && r.error?.startsWith('blocked_by_site')) {
      const http = /\((\d{3})\)/.exec(r.error)?.[1];
      return `the site blocks automated checks${http ? ` (HTTP ${http})` : ''}`;
    }
    return `unavailable (${firstNote(r.error)})`;
  }
  switch (name) {
    case 'repo': {
      const f = r.facts as RepoFacts;
      return `${plural(f.commits.length, 'commit')}, ${plural(f.releases.length, 'release')}${r.degraded ? ' · partial' : ''}`;
    }
    case 'liveapp': {
      const f = r.facts as LiveAppFacts;
      if (!f.up) return `not responding (${f.httpStatus ? `HTTP ${f.httpStatus}` : firstNote(r.error)})`;
      if (!hadPrev) return `up · HTTP ${f.httpStatus} · first look, nothing to compare yet`;
      const text = f.textDelta && f.textDelta.changedChars > 0 ? ` · ${size(f.textDelta.changedChars)} of text changed` : '';
      return `${f.newDeploy ? 'new deploy' : 'same deploy'}${text}`;
    }
    case 'chain': {
      const f = r.facts as ChainFacts;
      const txs = f.contracts.reduce((n, c) => n + c.txCount, 0);
      const parts = [`${plural(txs, 'tx')} on ${plural(f.contracts.length, 'contract')}`];
      if (f.newDeployments.length) parts.push(`${plural(f.newDeployments.length, 'new contract')}`);
      return parts.join(', ') + (r.degraded ? ' · partial' : '');
    }
    case 'vibestarter': {
      const f = r.facts as VibestarterFacts;
      const paid = f.tranches.filter((t) => t.status.toUpperCase() === 'PAID').length;
      const parts = [`raise ${f.raiseStatus.toLowerCase()}`, `${paid}/${f.tranches.length} tranches paid`];
      if (f.openWindow?.windowEndsAt) parts.push(`challenge window open until ${f.openWindow.windowEndsAt.slice(0, 10)}`);
      if (f.founderUpdates.length) parts.push(plural(f.founderUpdates.length, 'founder update'));
      return parts.join(' · ');
    }
  }
}

/** Run the applicable adapters in parallel; each is isolated (a throw becomes ok:false with a fixed code). */
async function gather(
  project: ProjectRow, window: TimeWindow, prev: Prev, deps: ShiftDeps, step: (k: StepKey, s: Step['state'], d?: string) => void,
): Promise<{ sources: Sources; liveText: string | null; repoEtag: string | null }> {
  const a = resolveAdapters(deps);
  const contracts = (project.contracts ?? []).filter((c) => c.role !== 'deployer');
  const deployer = (project.contracts ?? []).find((c) => c.role === 'deployer')?.address ?? null;
  const vs = project.vibestarter;
  let liveText: string | null = null;
  let repoEtag: string | null = null;

  const jobs: Record<SourceName, (() => Promise<AnyResult>) | null> = {
    repo: project.repoHost && project.repo
      ? async () => {
        const r = await a.repo(
          { host: project.repoHost!, repo: project.repo!, branch: project.defaultBranch ?? undefined },
          window,
          prev.repo?.headSha ?? null,
          { fetch: deps.fetch, token: deps.githubToken, budget: (n) => deps.budget('github_calls', n), prevEtag: prev.repo?.etag ?? null },
        );
        repoEtag = r.etag;
        return r.result;
      }
      : null,
    liveapp: project.liveUrl
      ? async () => {
        const r = await a.liveapp(project.liveUrl!, prev.live?.facts ?? null, {
          fetch: deps.fetch,
          ...(prev.live?.text != null ? { prevText: prev.live.text } : {}),
        });
        liveText = r.text;
        return r.result;
      }
      : null,
    chain: contracts.length > 0 || deployer
      ? () => a.chain(contracts, deployer, window, { fetch: deps.fetch, ...(deps.rpc ? { client: deps.rpc } : {}) })
      : null,
    vibestarter: vs?.campaignId && vs.escrow
      ? () => a.vibestarter(vs.campaignId, vs.escrow, window, { fetch: deps.fetch, ...(deps.rpc ? { client: deps.rpc } : {}) })
      : null,
  };

  const names: SourceName[] = ['repo', 'liveapp', 'chain', 'vibestarter'];
  const results = await Promise.all(names.map(async (name): Promise<AnyResult | null> => {
    const job = jobs[name];
    if (!job) {
      step(name, 'ok', 'not listed for this project');
      return null;
    }
    step(name, 'start');
    let res: AnyResult;
    let state: Step['state'];
    let detail: string;
    try {
      res = plain(await job());
      res.source = name;
      // inside the try: facts of an unexpected shape fail this source, never the run
      state = stateOf(name, res);
      detail = detailOf(name, res, name === 'liveapp' ? prev.live !== null : true);
    } catch (e) {
      res = { source: name, tier: 'verified', ok: false, facts: null, error: safeErrorCode(e) };
      state = 'fail';
      detail = `unavailable (${res.error})`;
    }
    step(name, state, detail);
    return res;
  }));

  const [repo, liveapp, chain, vibestarter] = results;
  return {
    sources: {
      repo: repo as Sources['repo'],
      liveapp: liveapp as Sources['liveapp'],
      chain: chain as Sources['chain'],
      vibestarter: vibestarter as Sources['vibestarter'],
    },
    liveText,
    repoEtag,
  };
}

/**
 * Explain within the LLM caps. Afterwards only what explain proves unused is refunded (`refundable`: calls never made,
 * or made with a reported usage below their reservation); a failed call or a missing usage figure keeps its whole
 * reservation, and so does an explain that throws.
 */
async function safeExplain(b: EvidenceBundle, d: Decision, deps: ShiftDeps): Promise<Explanation> {
  let reserved = 0;
  const budget = async (n: number) => {
    const ok = await deps.budget('llm_tokens', n);
    if (ok) reserved += n;
    return ok;
  };
  let ex: Explanation;
  try {
    ex = await deps.explain(b, d, { budget });
  } catch {
    return { aiOk: false, summary: null, notable: [], aiSubstance: null, model: null, tokens: 0, refundable: 0 };
  }
  const refund = Math.min(reserved, Math.max(0, Math.floor(ex.refundable ?? 0)));
  if (refund > 0) await deps.release?.('llm_tokens', refund)?.catch(() => undefined);
  return ex;
}

/** Compact per-source facts for the nights row (the full facts live in the evidence bundle). */
function signalsOf(b: EvidenceBundle, d: Decision, ex: Explanation): Record<string, unknown> {
  const { repo, liveapp, chain, vibestarter } = b.sources;
  const head = (r: AnyResult) => ({ ok: r.ok, ...(r.degraded ? { degraded: true } : {}), ...(r.error ? { error: r.error } : {}) });
  return {
    reasons: d.reasons,
    aiSubstance: ex.aiSubstance,
    repo: repo && {
      ...head(repo),
      ...(repo.facts ? {
        mode: repo.facts.mode,
        commits: repo.facts.commits.length,
        codeCommits: repo.facts.commits.filter((c) => c.kind === 'code' && !c.authorIsBot).length,
        releases: repo.facts.releases.length,
      } : {}),
    },
    liveapp: liveapp && {
      ...head(liveapp),
      ...(liveapp.facts ? {
        up: liveapp.facts.up,
        httpStatus: liveapp.facts.httpStatus,
        newDeploy: liveapp.facts.newDeploy,
        latencyMs: liveapp.facts.latencyMs,
        changedChars: liveapp.facts.textDelta?.changedChars ?? null,
      } : {}),
    },
    chain: chain && {
      ...head(chain),
      ...(chain.facts ? {
        txCount: chain.facts.contracts.reduce((n, c) => n + c.txCount, 0),
        newDeployments: chain.facts.newDeployments.length,
      } : {}),
    },
    vibestarter: vibestarter && {
      ...head(vibestarter),
      ...(vibestarter.facts ? {
        raiseStatus: vibestarter.facts.raiseStatus,
        openWindowEndsAt: vibestarter.facts.openWindow?.windowEndsAt ?? null,
        founderUpdates: vibestarter.facts.founderUpdates.length,
      } : {}),
    },
  };
}

/**
 * Keep the campaign's tranche schedule (challenge windows) in `tranche_events` for the briefings and the open API.
 * Best effort: a failed write never fails the run; the readers then fall back to the latest evidence.
 */
async function recordTranches(db: Db, projectId: number, b: EvidenceBundle): Promise<void> {
  const v = b.sources.vibestarter;
  if (!v?.ok || !v.facts || !Array.isArray(v.facts.tranches) || v.facts.tranches.length === 0) return;
  try {
    await upsertTrancheEvents(db, projectId, v.facts.tranches);
  } catch (e) {
    console.error('shift.tranches failed:', safeErrorCode(e));
  }
}

function attestDetail(o: AttestOutcome): string {
  if ('uid' in o) return `attested · uid ${short(o.uid)}`;
  if (o.txHash && o.error !== 'reverted') return `sent, not confirmed yet · tx ${short(o.txHash)}`;
  if (o.skipped === 'gas_cap') return 'skipped (daily gas cap)';
  if (o.skipped === 'disabled') return 'skipped (attestation disabled)';
  return `skipped (${o.error ? firstNote(o.error) : o.skipped})`;
}

/**
 * One project through the pipeline: adapters (parallel, isolated) -> bundle -> rules -> explain -> evidence.
 * Nightly: writes the `nights` row (throws DuplicateNight if the project-night exists; nothing else is written
 * then) and only afterwards advances the snapshots and the tranche schedule. Live: never writes nights or snapshots
 * (it does refresh the tranche schedule); updates its
 * `live_runs` row and attests once (a skipped attestation still ends `done`).
 */
export async function runProject(
  projectId: number, kind: Kind, window: TimeWindow, deps: ShiftDeps, emit?: (s: Step) => void, opts: RunOptions = {},
): Promise<RunResult> {
  const { db } = deps;
  const steps: Step[] = [];
  const open = new Set<StepKey>();
  const step = (key: StepKey, state: Step['state'], detail?: string) => {
    if (state === 'start') open.add(key);
    else open.delete(key);
    const s: Step = { at: deps.now().toISOString(), key, label: STEP_LABELS[key], state, ...(detail ? { detail } : {}) };
    steps.push(s);
    try { emit?.(s); } catch { /* a closed stream never stops the run */ }
  };
  let liveRunId = opts.liveRunId;

  try {
    step('load', 'start');
    const project = await getProjectById(db, projectId);
    if (!project) throw new Error('project_not_found');
    if (kind === 'live' && liveRunId === undefined) {
      liveRunId = (await insertLiveRun(db, {
        projectId, startedAt: deps.now(), status: 'running', requesterIpHash: opts.ipHash ?? null,
      })).id;
    }
    const night = kind === 'nightly' ? nightNumber(new Date(window.end)) : nightNumber(deps.now());
    const prev = await loadPrev(db, projectId);
    step('load', 'ok', `${project.name} · ${spanLabel(window)}`);

    const g = await gather(project, window, prev, deps, step);
    const bundle: EvidenceBundle = plain({
      v: 1, rulesVersion: RULES_VERSION, project: project.slug, night, kind, window, sources: g.sources,
    });

    step('rules', 'start');
    const decision = decideStatus(bundle);
    step('rules', 'ok', `${decision.status} · ${decision.reasons.join(', ')}`);

    step('explain', 'start');
    const ex = await safeExplain(bundle, decision, deps);
    step('explain', ex.aiOk && ex.summary ? 'ok' : 'warn', ex.summary ?? 'explanation unavailable');

    step('evidence', 'start');
    const evidenceHash = hashEvidence(bundle);
    await saveEvidence(db, evidenceHash, projectId, nightDate(night), bundle);
    step('evidence', 'ok', `${short(evidenceHash)} · ${size(JSON.stringify(bundle).length)} bundle`);

    if (kind === 'nightly') {
      const shiftId = opts.shiftId ?? (await getNightlyShift(db, nightDate(night)))?.id ?? null;
      const row = await insertNight(db, {
        projectId, night: nightDate(night), shiftId, status: decision.status, observed: true,
        signals: signalsOf(bundle, decision, ex), summary: ex.summary, notable: ex.notable,
        evidenceHash, aiModel: ex.model, aiOk: ex.aiOk,
      });
      await recordTranches(db, projectId, bundle);
      // The row is ours: only now advance the diff baselines (a duplicate run must not move them).
      const live = bundle.sources.liveapp;
      if (live?.ok && live.facts?.up) {
        await saveSnapshot(db, {
          projectId, adapter: 'liveapp', fingerprint: live.facts.deployFingerprint,
          data: { facts: live.facts, text: g.liveText?.slice(0, MAX_SNAPSHOT_TEXT) ?? null },
        });
      }
      const repo = bundle.sources.repo;
      if (repo?.ok && repo.facts) {
        const headSha = repo.facts.headSha ?? prev.repo?.headSha ?? null;
        await saveSnapshot(db, { projectId, adapter: 'repo', fingerprint: headSha, data: { headSha, etag: g.repoEtag } });
      }
      return { night, status: decision.status, evidenceHash, nightId: row.id };
    }

    await recordTranches(db, projectId, bundle);
    step('attest', 'start');
    const history = await getNights(db, projectId, { from: lit30From(night) });
    const att = toAttestation(
      { slug: project.slug, night, kind: 'live', status: decision.status, lit30: lit30Of(history, night), evidenceHash },
      deps,
    );
    let outcome: AttestOutcome;
    if (!canAttest(deps)) {
      outcome = { skipped: 'disabled' }; // no registered watcher identity: never attest agentId 0
    } else {
      let sent: Hex | undefined;
      // Runs after signing and BEFORE the raw tx is sent: if this write fails, nothing is sent.
      const onBroadcast = async (h: Hex) => {
        await updateLiveRun(db, liveRunId!, { tx: h });
        sent = h;
      };
      try {
        const r = await deps.attest(att, attestDepsFor(deps, onBroadcast, { receiptTimeoutMs: LIVE_RECEIPT_TIMEOUT_MS }));
        if ('skipped' in r) {
          const tx = r.txHash ?? sent;
          outcome = { skipped: r.skipped, ...(r.error ? { error: r.error } : {}), ...(tx ? { txHash: tx } : {}) };
        } else {
          outcome = { uid: r.uid, txHash: r.txHash };
        }
      } catch (e) {
        outcome = { skipped: 'error', error: safeErrorCode(e), ...(sent ? { txHash: sent } : {}) };
      }
    }
    step('attest', 'uid' in outcome ? 'ok' : 'warn', attestDetail(outcome));
    await updateLiveRun(db, liveRunId!, {
      steps, status: 'done', evidenceHash,
      attestationUid: 'uid' in outcome ? outcome.uid : null,
      // a broadcast-but-unconfirmed attestation keeps its tx, so it can be looked up later
      tx: 'uid' in outcome || (outcome.txHash && outcome.error !== 'reverted') ? outcome.txHash ?? null : null,
    });
    return { night, status: decision.status, evidenceHash, liveRunId, attestation: outcome };
  } catch (e) {
    if (kind === 'live' && liveRunId !== undefined) {
      const detail = e instanceof Error && e.message === 'project_not_found' ? 'project not found' : safeErrorCode(e);
      for (const k of [...open]) step(k, 'fail', detail);
      await updateLiveRun(db, liveRunId, { steps, status: 'failed' }).catch(() => undefined);
    }
    throw e;
  }
}

/** [last nightly shift start for the project, now), or the last 24 h if there is none. */
export async function liveWindow(db: Db, projectId: number, now: Date): Promise<TimeWindow> {
  const last = await getLatestNightly(db, projectId);
  if (last) {
    const start = shiftStartOfNight(last.night);
    if (start.getTime() < now.getTime()) return { start: start.toISOString(), end: now.toISOString() };
  }
  return { start: new Date(now.getTime() - DAY_MS).toISOString(), end: now.toISOString() };
}

/**
 * One project of a nightly shift (the /api/shift/run body). Counts itself done (atomic increment) unless it was a
 * duplicate; the run that brings done to planned finalizes the shift.
 */
export async function runShiftProject(
  shiftId: number, projectId: number, deps: ShiftDeps,
): Promise<{ ok: boolean; code?: string; finalized?: boolean }> {
  const shift = await getShift(deps.db, shiftId);
  if (!shift || shift.kind !== 'nightly') return { ok: false, code: 'shift_not_found' };
  if (shift.finishedAt) return { ok: false, code: 'shift_closed' };
  const window = nightlyWindow(shiftStartOfNight(shift.night));

  let code: string | undefined;
  try {
    await runProject(projectId, 'nightly', window, deps, undefined, { shiftId });
  } catch (e) {
    if (e instanceof DuplicateNight) return { ok: false, code: 'duplicate' };
    console.error('shift.run project failed:', safeErrorCode(e));
    code = 'run_failed'; // still counts: finalize fills this project's night as unavailable
  }

  let finalized = false;
  const counts = await markShiftRunDone(deps.db, shiftId);
  if (counts && counts.done === counts.planned) {
    try {
      await finalizeShift(shiftId, deps);
      finalized = true;
    } catch (e) {
      // finalizeShift handles its own failures (status attest_pending); this only catches a dead DB. The shift then stays
      // unfinished and is recovered by a stale pass: the 05:00 UTC dispatch (after()), the 06:00 UTC finalize-stale
      // cron, or the after() of a later /api/shift/run.
      console.error('shift.finalize failed:', safeErrorCode(e));
    }
  }
  return code ? { ok: false, code, finalized } : { ok: true, finalized };
}
