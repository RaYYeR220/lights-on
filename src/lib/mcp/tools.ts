import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import type { Db } from '@/lib/db';
import {
  LETTER_STATUS, countWatches, deleteProjectById, getLeanNights, getNightDigests, getNights, getProjectByLiveUrl,
  getProjectBySlug, getTranches, insertProjectIfNew, listListedProjectCards, unhideWatchProject,
  type LeanNightRow, type NightDigest,
} from '@/lib/db/queries';
import type { NightRow, ProjectRow } from '@/lib/db/schema';
import { safeFetch, type SafeFetchResult } from '@/lib/net/safeFetch';
import { safeErrorCode } from '@/lib/net/redact';
import { validRepo } from '@/lib/adapters/repo';
import { schemaUid } from '@/lib/attest/eas';
import { checkBriefingLimit } from '@/lib/briefingLimit';
import { briefingFor, resolveAddressInput } from '@/lib/briefingService';
import { clientIp, hashIp } from '@/lib/shift/limits';
import { nightDate, nightNumber, nightOf, utcDay } from '@/lib/shift/night';
import { computeRecord } from '@/lib/shift/rules';
import { siteUrl } from '@/lib/site';
import type { Record30, Status } from '@/lib/types';

import { ToolError } from './errors';

export { ToolError };

export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
/** How far back streak/lit30 are computed from (a streak longer than this reads as this long). */
const RECORD_DAYS = 180;
const MAX_RANGE_DAYS = 366;
export const VERIFIED_BY = 'EAS on Base';

// ---- helpers ----

const dayNumber = (n: number) => Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100) / DAY_MS;
const fromDayNumber = (d: number) => nightNumber(new Date(d * DAY_MS));
const validNight = (n: unknown): n is number => {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 20200101 || n > 20991231) return false;
  return fromDayNumber(dayNumber(n)) === n;
};
const daysBack = (now: Date, days: number) => nightDate(nightNumber(new Date(now.getTime() - days * DAY_MS)));

async function visibleProject(db: Db, slug: string): Promise<ProjectRow> {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new ToolError('not_found', 404);
  const p = await getProjectBySlug(db, slug);
  if (!p || p.hidden) throw new ToolError('not_found', 404);
  return p;
}

type Digest = NightDigest | undefined;

/** Digest letters (one per night from `from`) -> the nights that have a status, oldest first. */
function decodeNights(codes: string, from: string): { night: number; status: Status }[] {
  const base = dayNumber(nightOf(from));
  const out: { night: number; status: Status }[] = [];
  for (let i = 0; i < codes.length; i++) {
    const st = LETTER_STATUS[codes[i]];
    if (st) out.push({ night: fromDayNumber(base + i), status: st });
  }
  return out;
}

/** Record over the digest; head = latest observed night, only without any the latest reconstructed one. */
function summarise(d: Digest, from: string, now: Date) {
  const record: Record30 = computeRecord(decodeNights(d?.codes ?? '', from), nightNumber(now));
  const head = d?.head ?? null;
  return { record, head, observed: !!head?.observed };
}

async function digests(db: Db, ids: number[], now: Date): Promise<{ from: string; by: Map<number, NightDigest> }> {
  const from = daysBack(now, RECORD_DAYS);
  const list = await getNightDigests(db, ids, from, nightDate(nightNumber(now)));
  return { from, by: new Map(list.map((d) => [d.projectId, d])) };
}

const reasonList = (r: unknown): string[] => (Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []);

const evidenceUri = (hash: string | null) => (hash ? `${siteUrl()}/api/v1/evidence/${hash}` : null);

type NightFields = Pick<LeanNightRow, 'night' | 'observed' | 'status' | 'summary' | 'evidenceHash' | 'attestationUid' | 'attestTx'>;
function nightView(r: NightFields, reasons: unknown) {
  return {
    night: nightOf(r.night),
    observed: r.observed,
    status: r.status,
    reasons: reasonList(reasons),
    summary: r.summary,
    evidenceHash: r.evidenceHash,
    evidenceUri: evidenceUri(r.evidenceHash),
    attestationUid: r.attestationUid,
    attestTx: r.attestTx,
  };
}
const fullNightView = (r: NightRow) => nightView(r, (r.signals as { reasons?: unknown } | null)?.reasons);

// ---- read tools ----

/**
 * `history`: the last 90 nights as one 90-letter string, oldest first, the last letter = today (UTC):
 * S shipped, B building, Q quiet, D down, U unavailable, '.' no night. (Was an array of 90 status strings: 10x the bytes.)
 */
export const HISTORY_LEGEND = 'S shipped, B building, Q quiet, D down, U unavailable, . no night';

export async function listProjects(db: Db, opts: { history?: boolean } = {}, now: Date = new Date()) {
  const projs = await listListedProjectCards(db); // community watches are unlisted
  const { from, by } = await digests(db, projs.map((p) => p.id), now);
  return {
    generatedAt: now.toISOString(),
    projects: projs.map((p) => {
      const d = by.get(p.id);
      const { record, head, observed } = summarise(d, from, now);
      const out: ProjectListItem = {
        slug: p.slug, name: p.name, tagline: p.tagline, source: p.source, bay: p.bay,
        status: head?.status ?? null,
        ...(head && !observed ? { statusSource: 'reconstructed' as const } : {}),
        confirmedAt: observed && head ? head.createdAt.toISOString() : null,
        summary: observed && head ? head.summary : null,
        record,
      };
      if (opts.history) out.history = (d?.codes ?? '').padStart(HISTORY_DAYS, '.').slice(-HISTORY_DAYS);
      return out;
    }),
  };
}

export interface ProjectListItem {
  slug: string; name: string; tagline: string | null; source: ProjectRow['source']; bay: number | null;
  status: Status | null; statusSource?: 'reconstructed'; confirmedAt: string | null; summary: string | null;
  record: Record30;
  /** 90 letters, oldest first, last = today: see HISTORY_LEGEND. */
  history?: string;
}

export async function getProject(db: Db, slug: string, now: Date = new Date()) {
  const p = await visibleProject(db, slug);
  const { from, by } = await digests(db, [p.id], now);
  const { record, head, observed } = summarise(by.get(p.id), from, now);
  const headRow = head
    ? (await getNights(db, p.id, { from: head.night, to: head.night })).find((r) => r.observed === head.observed) ?? null
    : null;

  let vibestarter: unknown = null;
  if (p.vibestarter) {
    const tr = await getTranches(db, p.id);
    const open = tr.find((t) => t.windowEndsAt && t.windowEndsAt.getTime() > now.getTime()) ?? null;
    vibestarter = {
      campaignId: p.vibestarter.campaignId,
      escrow: p.vibestarter.escrow,
      tranches: tr.map((t) => ({
        index: t.trancheIndex,
        requestedAt: t.requestedAt?.toISOString() ?? null,
        windowEndsAt: t.windowEndsAt?.toISOString() ?? null,
        amountWei: t.amountWei,
      })),
      openWindow: open ? { index: open.trancheIndex, windowEndsAt: open.windowEndsAt?.toISOString() ?? null } : null,
    };
  }
  return {
    slug: p.slug, name: p.name, tagline: p.tagline, category: p.category, source: p.source, bay: p.bay,
    liveUrl: p.liveUrl, repoHost: p.repoHost, repo: p.repo,
    contracts: p.contracts ?? [],
    claimed: !!p.claimVerifiedAt,
    ...(p.source === 'community' ? { communityAdded: true as const } : {}),
    status: head?.status ?? null,
    ...(head && !observed ? { statusSource: 'reconstructed' as const } : {}),
    record,
    latestNight: headRow ? fullNightView(headRow) : null,
    vibestarter,
  };
}

export async function getNight(db: Db, slug: string, night: number) {
  const p = await visibleProject(db, slug);
  if (!validNight(night)) throw new ToolError('bad_request', 400);
  const rows = await getLeanNights(db, p.id, nightDate(night), nightDate(night));
  const row = rows.find((r) => r.observed) ?? rows[0];
  if (!row) throw new ToolError('night_not_found', 404);
  return { slug: p.slug, ...nightView(row, row.reasons) };
}

export async function getProjectNights(
  db: Db, slug: string, range: { from?: number; to?: number } = {}, now: Date = new Date(),
) {
  const p = await visibleProject(db, slug);
  const to = range.to ?? nightNumber(now);
  const from = range.from ?? fromDayNumber(dayNumber(to) - (HISTORY_DAYS - 1));
  if (!validNight(to) || !validNight(from) || from > to) throw new ToolError('bad_request', 400);
  const fromClamped = Math.max(from, fromDayNumber(dayNumber(to) - (MAX_RANGE_DAYS - 1)));
  const rows = await getLeanNights(db, p.id, nightDate(fromClamped), nightDate(to));
  return { slug: p.slug, from: fromClamped, to, nights: rows.map((r) => nightView(r, r.reasons)) };
}

export async function isStillShipping(db: Db, slug: string, now: Date = new Date()) {
  const p = await visibleProject(db, slug);
  const { from, by } = await digests(db, [p.id], now);
  const { record, head } = summarise(by.get(p.id), from, now);
  return {
    slug: p.slug,
    status: head?.status ?? null,
    streak: record.streak,
    lit30: record.lit30,
    lastShip: record.lastShip,
    lastNight: head ? nightOf(head.night) : null,
    attestationUid: head?.attestationUid ?? null,
    verifiedBy: VERIFIED_BY,
    schemaUid: schemaUid(),
  };
}

export async function getBriefing(db: Db, rawAddress: string, headers?: Headers) {
  // Always limited: callers without a known address share the 'unknown' bucket.
  const wait = checkBriefingLimit(headers ?? new Headers());
  if (wait !== null) throw new ToolError('rate_limited', 429, wait);
  const raw = String(rawAddress ?? '').trim();
  const r = await resolveAddressInput(raw);
  if ('error' in r) throw new ToolError(r.error, r.status);
  return briefingFor(db, r.address);
}

// ---- watch ----

export const watchInput = z.object({
  liveUrl: z.string().min(1).max(2048),
  repo: z.string().min(1).max(300).optional(),
  contract: z.string().min(1).max(100).optional(),
});
export type WatchInput = z.infer<typeof watchInput>;

export const WATCH_LIMITS = { perIpPerDay: 3, globalPerDay: 50, attempts: 20, attemptWindowMs: 10 * 60_000 } as const;

export interface WatchCtx {
  headers: Headers;
  now?: () => Date;
  /** Test seam; defaults to the SSRF-guarded safeFetch. */
  fetch?: (url: string) => Promise<SafeFetchResult>;
  /** Runs the first shift after the response; defaults to next's `after()`. */
  schedule?: (p: Promise<unknown>) => void;
  /** Test seam for the first run itself. */
  runFirst?: (project: ProjectRow, ipHash: string) => Promise<void>;
}

// Per-instance guard on validation attempts (each one makes an outbound request); the durable daily caps are in the DB.
const attempts = new Map<string, number[]>();
export function resetWatchLimit(): void { attempts.clear(); }
function attemptAllowed(key: string, nowMs: number): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => nowMs - t < WATCH_LIMITS.attemptWindowMs);
  if (recent.length >= WATCH_LIMITS.attempts) { attempts.set(key, recent); return false; }
  recent.push(nowMs);
  attempts.set(key, recent);
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value as string);
  return true;
}

/** `owner/name`, or a github.com / gitlab.com URL -> {host, repo}; null when it is neither or fails validRepo. */
export function parseRepoInput(raw: string): { host: 'github' | 'gitlab'; repo: string } | null {
  const s = raw.trim();
  let host: 'github' | 'gitlab' = 'github';
  let parts: string[];
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    if (h === 'github.com') host = 'github';
    else if (h === 'gitlab.com') host = 'gitlab';
    else return null;
    parts = u.pathname.split('/').filter(Boolean);
    const dash = parts.indexOf('-');
    if (dash >= 0) parts = parts.slice(0, dash);
    if (host === 'github') parts = parts.slice(0, 2);
  } else {
    parts = s.split('/');
  }
  if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  const repo = parts.join('/');
  return validRepo({ host, repo }) ? { host, repo } : null;
}

function slugFromUrl(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (host || 'site').slice(0, 70);
}

const untilUtcMidnight = (now: Date) =>
  Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));

async function defaultSchedule(p: Promise<unknown>): Promise<void> {
  try {
    const { after } = await import('next/server');
    after(p);
  } catch {
    // outside a request scope: the promise simply keeps running
  }
}

async function defaultRunFirst(db: Db, project: ProjectRow, ipHash: string): Promise<void> {
  const [{ makeShiftDeps }, { runProject, liveWindow }, { checkLiveLimit }] = await Promise.all([
    import('@/lib/shift/deps'), import('@/lib/shift/run'), import('@/lib/shift/limits'),
  ]);
  // Never act on a row a moderator touched (or any non-watch row): re-read, then check the marker.
  const fresh = await getProjectBySlug(db, project.slug);
  if (!fresh || !fresh.addedBy?.startsWith('watch:')) return;
  const deps = makeShiftDeps(db, { kind: 'live' });
  // Same admission as a public live run: daily live_runs counter, 1 per project per 5 min, 3 per requester per 10 min.
  const limit = await checkLiveLimit(ipHash, project.id, deps);
  if (!limit.ok) return; // stays hidden; a later watch of the same URL re-queues it
  const window = await liveWindow(db, project.id, deps.now());
  const r = await runProject(project.id, 'live', window, deps, undefined, { liveRunId: limit.liveRunId, ipHash });
  if (r.status !== 'unavailable') await unhideWatchProject(db, project.id); // no-op if moderated meanwhile
}

/**
 * Add a community project: validate (SSRF-guarded fetch), rate-limit (DB-backed: 3/day per IP hash, 50/day global,
 * counted on the projects table by `added_by = watch:<ip hash>`), insert hidden, then run the first shift after the
 * response. The project is unhidden only if that run finishes with a claim; otherwise it stays hidden. Community
 * projects are unlisted (never in lists), served by slug only. A hidden row with the same URL is re-queued.
 */
export async function watchProject(db: Db, input: unknown, ctx: WatchCtx): Promise<{ slug?: string; status: 'queued' | 'exists' }> {
  const secret = process.env.INTERNAL_RUN_TOKEN;
  if (!secret) throw new ToolError('misconfigured', 503);
  const now = ctx.now?.() ?? new Date();
  const parsed = watchInput.safeParse(input);
  if (!parsed.success) throw new ToolError('bad_request', 400);
  const { liveUrl, repo, contract } = parsed.data;

  const ipHash = hashIp(clientIp(ctx.headers), utcDay(now), secret);
  if (!attemptAllowed(ipHash, now.getTime())) throw new ToolError('rate_limited', 429, 60);

  let url: URL;
  try { url = new URL(liveUrl); } catch { throw new ToolError('invalid_url', 400); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ToolError('invalid_url', 400);
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  const normalized = url.toString();

  let repoRef: { host: 'github' | 'gitlab'; repo: string } | null = null;
  if (repo !== undefined) {
    repoRef = parseRepoInput(repo);
    if (!repoRef) throw new ToolError('invalid_repo', 400);
  }
  let contractAddr: string | null = null;
  if (contract !== undefined) {
    if (!isAddress(contract, { strict: false })) throw new ToolError('invalid_contract', 400);
    contractAddr = getAddress(contract);
  }

  // The site must answer (any HTTP response below 500; 401/403/429 mean "blocking us", still alive).
  try {
    const res = await (ctx.fetch ?? ((u: string) => safeFetch(u, { timeoutMs: 8000, maxBytes: 64 * 1024 })))(normalized);
    if (res.status >= 500) throw new ToolError('unreachable', 400);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(safeErrorCode(e) === 'blocked_url' ? 'blocked_url' : 'unreachable', 400);
  }

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const marker = `watch:${ipHash}`;
  const over = async (beforeId?: number): Promise<boolean> =>
    (await countWatches(db, dayStart, marker, beforeId)) >= WATCH_LIMITS.perIpPerDay
    || (await countWatches(db, dayStart, undefined, beforeId)) >= WATCH_LIMITS.globalPerDay;
  if (await over()) throw new ToolError('rate_limited', 429, untilUtcMidnight(now));

  // Lookup only after validation and caps. A visible project is just reported; a hidden one (failed first run) is
  // re-queued under the same row and its slug is not revealed.
  const requeue = async (): Promise<{ slug?: string; status: 'queued' | 'exists' }> => {
    const existing = await getProjectByLiveUrl(db, normalized);
    if (!existing) throw new ToolError('internal', 500);
    if (!existing.hidden) return { slug: existing.slug, status: 'exists' };
    if (existing.source === 'community' && existing.addedBy?.startsWith('watch:')) {
      const job = (ctx.runFirst ? ctx.runFirst(existing, ipHash) : defaultRunFirst(db, existing, ipHash)).catch((e) => {
        console.error('watch re-run failed:', safeErrorCode(e));
      });
      if (ctx.schedule) ctx.schedule(job);
      else await defaultSchedule(job);
    }
    return { status: 'queued' };
  };
  if (await getProjectByLiveUrl(db, normalized)) return requeue();

  // Reserve-then-verify: a concurrent loser deletes its row.
  const base = slugFromUrl(url);
  let row: ProjectRow | null = null;
  for (let i = 1; i <= 20 && !row; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 75)}-${i}`;
    try {
      row = await insertProjectIfNew(db, {
      slug, name: url.hostname.replace(/^www\./, ''), tagline: null, source: 'community', liveUrl: normalized,
      repoHost: repoRef?.host ?? null, repo: repoRef?.repo ?? null,
      contracts: contractAddr ? [{ chainId: 8453, address: contractAddr, role: 'watched' }] : null,
      addedBy: marker, hidden: true, createdAt: now,
      });
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505') return requeue(); // another writer got this URL first
      throw e;
    }
  }
  if (!row) throw new ToolError('internal', 500);
  if (await over(row.id)) {
    await deleteProjectById(db, row.id);
    throw new ToolError('rate_limited', 429, untilUtcMidnight(now));
  }

  const created = row;
  const job = (ctx.runFirst ? ctx.runFirst(created, ipHash) : defaultRunFirst(db, created, ipHash)).catch((e) => {
    console.error('watch first run failed:', safeErrorCode(e)); // project stays hidden
  });
  if (ctx.schedule) ctx.schedule(job);
  else await defaultSchedule(job);
  return { slug: created.slug, status: 'queued' };
}
