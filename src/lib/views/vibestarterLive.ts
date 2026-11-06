import { unstable_cache } from 'next/cache';
import { safeFetch } from '@/lib/net/safeFetch';
import { safeErrorCode } from '@/lib/net/redact';

const URL_CAMPAIGNS = 'https://app.vibestarter.xyz/api/campaigns?limit=50';

export interface LiveTranche {
  index: number;
  status: string;
  releasePercent: number | null;
  requestedAt: string | null;
  windowEndsAt: string | null;
  amountPaidWei: string | null;
  challenges: number;
}

export interface LiveCampaign {
  campaignId: string;
  status: string;
  contributorCount: number | null;
  tranches: LiveTranche[];
  /** When the schedule was read from Vibestarter (ISO). */
  fetchedAt: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Vibestarter's /api/campaigns payload -> campaigns by id (unknown shapes are skipped, never guessed). */
export function parseCampaigns(raw: unknown, fetchedAt: string): Record<string, LiveCampaign> {
  const out: Record<string, LiveCampaign> = {};
  if (!isRec(raw) || !Array.isArray(raw.campaigns)) return out;
  for (const c of raw.campaigns) {
    if (!isRec(c)) continue;
    const id = str(c.id);
    if (!id) continue;
    const tranches = (Array.isArray(c.tranches) ? c.tranches.filter(isRec) : [])
      .map((t) => ({
        index: typeof t.orderIndex === 'number' ? t.orderIndex : -1,
        status: str(t.status) ?? 'UNKNOWN',
        releasePercent: typeof t.releasePercent === 'number' ? t.releasePercent : null,
        requestedAt: iso(t.requestedAt),
        windowEndsAt: iso(t.challengeWindowEndsAt),
        amountPaidWei: typeof t.amountPaid === 'string' && /^\d+$/.test(t.amountPaid) ? t.amountPaid : null,
        challenges: isRec(t._count) && typeof t._count.challenges === 'number' ? t._count.challenges : 0,
      }))
      .filter((t) => t.index >= 0)
      .sort((a, b) => a.index - b.index);
    out[id] = {
      campaignId: id,
      status: str(c.status) ?? 'UNKNOWN',
      contributorCount: typeof c.contributorCount === 'number' ? c.contributorCount : null,
      tranches,
      fetchedAt,
    };
  }
  return out;
}

const loadAll = unstable_cache(
  async (): Promise<Record<string, LiveCampaign>> => {
    const res = await safeFetch(URL_CAMPAIGNS, { timeoutMs: 8000, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`http_${res.status}`);
    return parseCampaigns(JSON.parse(res.body), new Date().toISOString());
  },
  ['vibestarter-campaigns-v1'],
  { revalidate: 600 },
);

/** The live tranche schedule of one campaign (cached 10 min); null when Vibestarter does not answer or lacks it. */
export async function getLiveCampaign(campaignId: string): Promise<LiveCampaign | null> {
  try {
    return (await loadAll())[campaignId] ?? null;
  } catch (e) {
    console.error('vibestarter live read failed:', safeErrorCode(e));
    return null;
  }
}

/** The first tranche whose challenge window is still open at `now`. */
export function openWindowOf(tranches: Pick<LiveTranche, 'index' | 'windowEndsAt'>[], now: number) {
  return tranches.find((t) => t.windowEndsAt !== null && Date.parse(t.windowEndsAt) > now) ?? null;
}
