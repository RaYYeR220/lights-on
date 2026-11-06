import { safeErrorCode } from '@/lib/net/redact';
import { decodeEventLog, type Hex } from 'viem';
import type { AdapterResult, TimeWindow, TrancheFact, VibestarterFacts } from '@/lib/types';
import { defaultFetch, type FetchFn } from '@/lib/adapters/chain';
import { getBaseClient, getLogsChunked, windowBlocks, type RpcLike } from '@/lib/adapters/baseRpc';
import { vibestarterEscrowAbi } from '@/lib/adapters/vibestarterAbi';

const API = 'https://app.vibestarter.xyz';

export interface VibestarterDeps {
  fetch?: FetchFn;
  /** Base RPC client (escrow logs); defaults to getBaseClient(). Tests inject a fake. */
  client?: RpcLike;
  /** Reference time for "challenge window still open". Defaults to window.end. */
  now?: string;
}

export interface CampaignListing {
  id: string;
  title: string;
  tagline: string;
  escrow: string;
  founderWallet: string;
  token: string | null;
  status: string;
  chainId: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function getJson(doFetch: FetchFn, url: string): Promise<unknown> {
  const res = await doFetch(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`http_${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('invalid_json');
  }
}

async function loadCampaigns(doFetch: FetchFn): Promise<Rec[]> {
  const j = await getJson(doFetch, `${API}/api/campaigns?limit=50`);
  if (!isRec(j) || !Array.isArray(j.campaigns)) throw new Error('invalid_json');
  return j.campaigns.filter(isRec);
}

export async function listVibestarterCampaigns(deps: { fetch?: FetchFn } = {}): Promise<CampaignListing[]> {
  const list = await loadCampaigns(deps.fetch ?? defaultFetch);
  const out: CampaignListing[] = [];
  for (const c of list) {
    const id = str(c.id);
    const escrow = str(c.escrowAddress);
    const founder = isRec(c.founder) ? str(c.founder.wallet) : null;
    if (!id || !escrow || !founder) continue;
    out.push({
      id,
      title: str(c.title) ?? '',
      tagline: str(c.tagline) ?? '',
      escrow,
      founderWallet: founder,
      token: isRec(c.token) ? str(c.token.address) : null,
      status: str(c.status) ?? 'UNKNOWN',
      chainId: typeof c.chainId === 'number' ? c.chainId : 0,
    });
  }
  return out;
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function trancheFacts(c: Rec): TrancheFact[] {
  const arr = Array.isArray(c.tranches) ? c.tranches.filter(isRec) : [];
  return arr
    .map((t) => ({
      index: typeof t.orderIndex === 'number' ? t.orderIndex : -1,
      status: str(t.status) ?? 'UNKNOWN',
      requestedAt: isoOrNull(t.requestedAt),
      windowEndsAt: isoOrNull(t.challengeWindowEndsAt),
      amountPaidWei: typeof t.amountPaid === 'string' ? t.amountPaid : typeof t.amountPaid === 'number' ? String(t.amountPaid) : null,
    }))
    .filter((t) => t.index >= 0)
    .sort((a, b) => a.index - b.index);
}

/** Maps varying activity shapes to {type, summary, at}; unknown shapes are skipped. */
function mapActivity(raw: unknown, w: TimeWindow): VibestarterFacts['reportedActivity'] {
  if (!isRec(raw) || !Array.isArray(raw.activities)) return [];
  const s = Date.parse(w.start);
  const e = Date.parse(w.end);
  const out: VibestarterFacts['reportedActivity'] = [];
  for (const a of raw.activities) {
    if (!isRec(a)) continue;
    const type = str(a.type) ?? str(a.kind) ?? str(a.event);
    const summary = str(a.summary) ?? str(a.message) ?? str(a.title) ?? str(a.description);
    const at = isoOrNull(a.at ?? a.createdAt ?? a.timestamp ?? a.date);
    if (!type || !summary || !at) continue;
    const t = Date.parse(at);
    if (t < s || t >= e) continue;
    out.push({ type, summary, at });
  }
  return out;
}

interface EscrowEvents {
  founderUpdates: VibestarterFacts['founderUpdates'];
  trancheRequests: { tranche: number; at: string }[];
  challenges: { tranche: number; blockNumber: bigint | null }[];
  calls: number;
  truncated: boolean;
}

/** FounderUpdate / TrancheRequested / ChallengeRaised on the escrow over the window's exact block range. Throws on RPC failure. */
async function readEscrowEvents(client: RpcLike, escrow: string, w: TimeWindow): Promise<EscrowEvents> {
  const range = await windowBlocks(client, w);
  const out: EscrowEvents = { founderUpdates: [], trancheRequests: [], challenges: [], calls: range.calls, truncated: false };
  if (range.toBlock < range.fromBlock) return out;
  const r = await getLogsChunked(client, { address: escrow as Hex, fromBlock: range.fromBlock, toBlock: range.toBlock });
  out.calls += r.calls;
  out.truncated = r.truncated;
  for (const l of r.logs) {
    if (l.topics.length === 0) continue;
    let d;
    try {
      d = decodeEventLog({ abi: vibestarterEscrowAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue; // unknown topic
    }
    if (d.eventName === 'FounderUpdate') {
      out.founderUpdates.push({ cid: d.args.ipfsCid, at: new Date(Number(d.args.timestamp) * 1000).toISOString() });
    } else if (d.eventName === 'TrancheRequested') {
      out.trancheRequests.push({ tranche: Number(d.args.tranche), at: new Date(Number(d.args.timestamp) * 1000).toISOString() });
    } else if (d.eventName === 'ChallengeRaised') {
      out.challenges.push({ tranche: Number(d.args.tranche), blockNumber: l.blockNumber });
    }
  }
  out.founderUpdates.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/**
 * Tranche state (REST), founder updates and challenges (escrow logs over RPC, exact block range, decoded with the
 * verified ABI) and founder-reported activity (`reportedActivity`: reported-tier data inside a verified result;
 * rules never read it). RPC or activity failure keeps the result ok with degraded + a note. Never throws.
 */
export async function checkVibestarter(
  campaignId: string,
  escrow: string,
  window: TimeWindow,
  deps: VibestarterDeps = {},
): Promise<AdapterResult<VibestarterFacts>> {
  const doFetch = deps.fetch ?? defaultFetch;
  const fail = (error: string, calls: number): AdapterResult<VibestarterFacts> => ({
    source: 'vibestarter',
    tier: 'verified',
    ok: false,
    facts: null,
    error,
    calls,
  });
  let calls = 0;
  let campaign: Rec | undefined;
  try {
    const list = await loadCampaigns(doFetch);
    calls++;
    campaign = list.find((c) => c.id === campaignId);
  } catch (e) {
    return fail(`campaigns_unavailable: ${safeErrorCode(e)}`, calls + 1);
  }
  if (!campaign) return fail(`campaign ${campaignId} not found`, calls);

  const tranches = trancheFacts(campaign);
  const nowMs = Date.parse(deps.now ?? window.end);
  const openWindow = tranches.find((t) => t.windowEndsAt !== null && Date.parse(t.windowEndsAt) > nowMs) ?? null;

  let degraded = false;
  const notes: string[] = [];
  let founderUpdates: VibestarterFacts['founderUpdates'] = [];
  let challengesRaised: NonNullable<VibestarterFacts['challengesRaised']> | undefined;
  try {
    const client = deps.client ?? getBaseClient();
    const ev = await readEscrowEvents(client, escrow, window);
    calls += ev.calls;
    founderUpdates = ev.founderUpdates;
    for (const req of ev.trancheRequests) {
      const t = tranches.find((x) => x.index === req.tranche);
      if (t && t.requestedAt === null) t.requestedAt = req.at;
    }
    challengesRaised = [];
    for (const c of ev.challenges.slice(0, 10)) {
      let at: string | null = null;
      if (c.blockNumber !== null) {
        try {
          const b = await client.getBlock({ blockNumber: c.blockNumber });
          at = new Date(Number(b.timestamp) * 1000).toISOString();
        } catch {
          at = null;
        }
      }
      challengesRaised.push({ tranche: c.tranche, at });
    }
    if (ev.truncated) {
      degraded = true;
      notes.push('logs_truncated');
    }
  } catch (e) {
    degraded = true;
    notes.push(`rpc_unavailable: ${safeErrorCode(e)}`);
  }

  let reportedActivity: VibestarterFacts['reportedActivity'] = [];
  try {
    const q = new URLSearchParams({ campaignId, limit: '50' });
    reportedActivity = mapActivity(await getJson(doFetch, `${API}/api/mcp/activity?${q.toString()}`), window);
    calls++;
  } catch {
    calls++;
    degraded = true;
    notes.push('activity_unavailable');
  }

  return {
    source: 'vibestarter',
    tier: 'verified',
    ok: true,
    ...(degraded ? { degraded: true } : {}),
    ...(notes.length ? { error: notes.join('; ') } : {}),
    facts: {
      campaignId,
      raiseStatus: str(campaign.status) ?? 'UNKNOWN',
      tranches,
      openWindow,
      founderUpdates,
      reportedActivity,
      ...(challengesRaised ? { challengesRaised } : {}),
    },
    calls,
  };
}
