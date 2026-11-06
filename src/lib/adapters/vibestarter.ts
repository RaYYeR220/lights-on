import { decodeEventLog, type Hex } from 'viem';
import type { PublicClient } from 'viem';
import type { AdapterResult, TimeWindow, TrancheFact, VibestarterFacts } from '@/lib/types';
import { BLOCKSCOUT_BASE, defaultFetch, fetchBlockscoutPages, type FetchFn } from '@/lib/adapters/chain';
import { vibestarterEscrowAbi } from '@/lib/adapters/vibestarterAbi';

const API = 'https://app.vibestarter.xyz';

export interface VibestarterDeps {
  fetch?: FetchFn;
  /**
   * Unused. Escrow events are read through the Blockscout v2 REST API instead of eth_getLogs on a public RPC
   * (public Base RPCs cap log ranges and Base's 200 ms blocks make block-range math fragile). Kept for the brief's signature.
   */
  client?: PublicClient;
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
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`non-JSON from ${new URL(url).pathname}`);
  }
}

async function loadCampaigns(doFetch: FetchFn): Promise<Rec[]> {
  const j = await getJson(doFetch, `${API}/api/campaigns?limit=50`);
  if (!isRec(j) || !Array.isArray(j.campaigns)) throw new Error('campaigns: unexpected shape');
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
  calls: number;
}

async function readEscrowEvents(doFetch: FetchFn, escrow: string, w: TimeWindow): Promise<EscrowEvents> {
  const s = Date.parse(w.start);
  const e = Date.parse(w.end);
  const decoded = (l: Rec) => {
    const topics = Array.isArray(l.topics) ? (l.topics.filter((t) => typeof t === 'string') as Hex[]) : [];
    if (topics.length === 0 || typeof l.data !== 'string') return null;
    try {
      return decodeEventLog({
        abi: vibestarterEscrowAbi,
        data: l.data as Hex,
        topics: topics as [Hex, ...Hex[]],
      });
    } catch {
      return null;
    }
  };
  const tsOf = (l: Rec): number | null => {
    const d = decoded(l);
    const a = d?.args as unknown as { timestamp?: bigint } | undefined;
    return a && typeof a.timestamp === 'bigint' ? Number(a.timestamp) * 1000 : null;
  };
  const r = await fetchBlockscoutPages(doFetch, `${BLOCKSCOUT_BASE}/addresses/${escrow}/logs`, (items) =>
    items.some((l) => {
      const t = tsOf(l);
      return t !== null && t < s;
    }),
  );
  const founderUpdates: EscrowEvents['founderUpdates'] = [];
  const trancheRequests: EscrowEvents['trancheRequests'] = [];
  for (const l of r.items) {
    const d = decoded(l);
    if (!d) continue;
    const t = tsOf(l);
    if (t === null || t < s || t >= e) continue;
    const at = new Date(t).toISOString();
    if (d.eventName === 'FounderUpdate') {
      founderUpdates.push({ cid: (d.args as { ipfsCid: string }).ipfsCid, at });
    } else if (d.eventName === 'TrancheRequested') {
      trancheRequests.push({ tranche: Number((d.args as { tranche: number }).tranche), at });
    }
  }
  founderUpdates.sort((a, b) => a.at.localeCompare(b.at));
  return { founderUpdates, trancheRequests, calls: r.calls };
}

/**
 * Tranche state (REST), founder updates (escrow logs via Blockscout, decoded with the verified ABI) and
 * founder-reported activity (`reportedActivity`: reported-tier data inside a verified result; rules never read it).
 * Never throws.
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
    return fail(e instanceof Error ? e.message : String(e), calls + 1);
  }
  if (!campaign) return fail(`campaign ${campaignId} not found`, calls);

  const tranches = trancheFacts(campaign);
  const nowMs = Date.parse(deps.now ?? window.end);
  const openWindow = tranches.find((t) => t.windowEndsAt !== null && Date.parse(t.windowEndsAt) > nowMs) ?? null;

  let degraded = false;
  const notes: string[] = [];
  let founderUpdates: VibestarterFacts['founderUpdates'] = [];
  try {
    const ev = await readEscrowEvents(doFetch, escrow, window);
    calls += ev.calls;
    founderUpdates = ev.founderUpdates;
    // Fill a missing requestedAt from the on-chain TrancheRequested event.
    for (const req of ev.trancheRequests) {
      const t = tranches.find((x) => x.index === req.tranche);
      if (t && t.requestedAt === null) t.requestedAt = req.at;
    }
  } catch (e) {
    degraded = true;
    notes.push(`escrow logs: ${e instanceof Error ? e.message : String(e)}`);
  }

  let reportedActivity: VibestarterFacts['reportedActivity'] = [];
  try {
    const q = new URLSearchParams({ campaignId, limit: '50' });
    reportedActivity = mapActivity(await getJson(doFetch, `${API}/api/mcp/activity?${q.toString()}`), window);
    calls++;
  } catch {
    calls++;
    reportedActivity = [];
  }

  return {
    source: 'vibestarter',
    tier: 'verified',
    ok: true,
    ...(degraded ? { degraded: true, error: notes.join('; ') } : {}),
    facts: {
      campaignId,
      raiseStatus: str(campaign.status) ?? 'UNKNOWN',
      tranches,
      openWindow,
      founderUpdates,
      reportedActivity,
    },
    calls,
  };
}
