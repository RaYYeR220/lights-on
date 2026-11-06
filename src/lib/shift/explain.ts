import { z } from 'zod';
import type { Decision, EvidenceBundle, Status } from '@/lib/types';
import { veniceJSON, veniceText, type FetchLike, type VeniceUsage } from '@/lib/ai/venice';
import {
  CLASSIFY_JSON_SCHEMA, CLASSIFY_SYSTEM, EXPLAIN_SYSTEM, MODEL_CLASSIFY, MODEL_EXPLAIN, UNTRUSTED_CLOSE, UNTRUSTED_OPEN,
} from '@/lib/ai/prompts';

export type AiSubstance = 'substantive' | 'mostly_cosmetic' | 'unclear';
export interface Explanation {
  aiOk: boolean;
  summary: string | null;
  notable: string[];
  aiSubstance: AiSubstance | null;
  model: string | null;
  /** Reported usage of the calls made (failed calls included when the API reported usage). */
  tokens: number;
  /**
   * Reservation provably unused: whole reservations of calls never made, plus (reserved - used) of calls that
   * succeeded with a reported usage. A failed call, or one without a usage figure, refunds nothing.
   */
  refundable: number;
}
export interface ExplainDeps {
  budget: (n: number) => Promise<boolean>;
  fetchImpl?: FetchLike;
  apiKey?: string;
  /** Aborts the Venice calls (the run's explain deadline). */
  signal?: AbortSignal;
}

const BANNED = /\b(scam|rug|dead|abandoned|fraud)\b/i;
const MAX_SUMMARY = 280;
const CLASSIFY_MAX_TOKENS = 700;
const EXPLAIN_MAX_TOKENS = 300;
const MAX_COMMIT_LINES = 60;
const MAX_RELEASE_LINES = 10;
/**
 * Upper bound on classifiable refs: 60 commits + 10 releases + d1, d2, x1 = 73, with room to spare. Enforced in zod only:
 * Venice answers HTTP 400 to a json_schema carrying maxItems, so CLASSIFY_JSON_SCHEMA must never get one.
 */
const MAX_CLASSIFY_ITEMS = 80;
const MAX_NOTABLE_CHARS = 120;

const ClassifySchema = z.object({
  items: z.array(z.object({ ref: z.string(), kind: z.enum(['feature', 'fix', 'refactor', 'docs', 'deps', 'chore', 'unclear']) })).max(MAX_CLASSIFY_ITEMS),
  ai_substance: z.enum(['substantive', 'mostly_cosmetic', 'unclear']),
  notable: z.array(z.string()),
});

/** Cut to <= n chars at a word boundary (hard cut only if there is no space). */
function cutAtWord(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 && t[n] !== ' ' ? cut.slice(0, sp) : cut).trim();
}

/** Plain text only: markdown, HTML and URLs stripped, <= 280 chars, null if empty or a banned word appears. */
export function sanitizeSummary(s: string): string | null {
  let t = String(s ?? '');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  t = t.replace(/[*_#`]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = cutAtWord(t, MAX_SUMMARY); // cut BEFORE the banned-word check so a truncation can never create one
  if (!t || BANNED.test(t)) return null;
  return t;
}

const TEMPLATES: Record<Status, string> = {
  shipped: 'A new release or deployment was recorded in this window; no further detail was available.',
  building: 'Code changes were recorded in this window; no further detail was available.',
  quiet: 'No new code or deploy reached users in this window.',
  down: 'The live app did not respond successfully during this window, and no new code or deploy was seen.',
  unavailable: 'None of the checked sources could be read in this window, so no claim is made either way.',
};

/** Neutralize angle brackets so untrusted text can never open or close the fence (case/whitespace/nesting proof). */
function neutralize(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›');
}
const clip = (s: string, n: number) => neutralize(s).replace(/\s+/g, ' ').trim().slice(0, n);

function buildInput(b: EvidenceBundle, d: Decision): { text: string; empty: boolean; refs: Set<string> } {
  const repo = b.sources.repo?.facts ?? null;
  const live = b.sources.liveapp?.facts ?? null;
  const chain = b.sources.chain?.facts ?? null;
  const lines: string[] = [];
  let count = 0;
  const refs = new Set<string>();
  let ci = 0;
  let ri = 0;

  const allCommits = [...(repo?.commits ?? [])].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  for (const c of allCommits.slice(0, MAX_COMMIT_LINES)) {
    count++;
    const ref = `c${++ci}`;
    refs.add(ref);
    const files = c.files && c.files.length ? ` files=[${c.files.slice(0, 30).map((f) => clip(f, 200)).join(', ')}]` : '';
    lines.push(`${ref} commit:${clip(c.sha, 12)} kind=${c.kind} "${clip(c.message.split('\n')[0] ?? '', 200)}"${files}`);
  }
  if (allCommits.length > MAX_COMMIT_LINES) lines.push(`(+${allCommits.length - MAX_COMMIT_LINES} more commits not shown)`);
  const allReleases = [...(repo?.releases ?? [])].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  for (const r of allReleases.slice(0, MAX_RELEASE_LINES)) {
    count++;
    const ref = `r${++ri}`;
    refs.add(ref);
    lines.push(`${ref} release:${clip(r.tag, 80)} name="${clip(r.name ?? '', 120)}"`);
  }
  if (allReleases.length > MAX_RELEASE_LINES) lines.push(`(+${allReleases.length - MAX_RELEASE_LINES} more releases not shown)`);
  if (live?.newDeploy) {
    count++;
    refs.add('d1');
    lines.push('d1 deploy: the live app has a new deployment');
  }
  const added = (live?.textDelta?.added ?? []).slice(0, 10);
  const removed = (live?.textDelta?.removed ?? []).slice(0, 10);
  if (added.length || removed.length) {
    count++;
    refs.add('d2');
    lines.push('d2 site_text:');
    for (const a of added) lines.push(`  added: ${clip(a, 200)}`);
    for (const r of removed) lines.push(`  removed: ${clip(r, 200)}`);
  }
  const nd = chain?.newDeployments.length ?? 0;
  if (nd > 0) {
    count++;
    refs.add('x1');
    lines.push(`x1 chain: ${nd} new contract deployment(s)`);
  }

  const text = [
    `Status (decided by fixed rules, do not contradict): ${d.status}`,
    `Reasons: ${d.reasons.join(', ')}`,
    UNTRUSTED_OPEN,
    lines.join('\n') || '(nothing recorded)',
    UNTRUSTED_CLOSE,
  ].join('\n');
  return { text, empty: count === 0, refs: refs };
}

const est = (chars: number) => Math.ceil(chars / 4);

/** Explains an already-decided night. Never changes the status; any failure -> aiOk false, summary null. */
export async function explainNight(b: EvidenceBundle, d: Decision, deps: ExplainDeps): Promise<Explanation> {
  let tokens = 0;
  let refundable = 0;
  /** Book one call against its reservation (see Explanation.refundable). */
  const book = (reserved: number, r: VeniceUsage & { ok: boolean }) => {
    if (r.tokens !== null) tokens += r.tokens;
    if (!r.sent) refundable += reserved;
    else if (r.ok && r.tokens !== null) refundable += Math.max(0, reserved - r.tokens);
  };
  const fail = (model: string | null): Explanation => ({ aiOk: false, summary: null, notable: [], aiSubstance: null, model, tokens, refundable });
  const input = buildInput(b, d);

  if (input.empty) {
    return { aiOk: true, summary: sanitizeSummary(TEMPLATES[d.status]), notable: [], aiSubstance: null, model: null, tokens: 0, refundable: 0 };
  }

  const net = { fetchImpl: deps.fetchImpl, apiKey: deps.apiKey, ...(deps.signal ? { signal: deps.signal } : {}) };

  const classifyUser = `Items to classify:\n${input.text}`;
  const clsReserve = CLASSIFY_MAX_TOKENS + est(CLASSIFY_SYSTEM.length + classifyUser.length);
  if (!(await deps.budget(clsReserve))) return fail(null);
  const cls = await veniceJSON({
    model: MODEL_CLASSIFY, system: CLASSIFY_SYSTEM, user: classifyUser,
    schema: ClassifySchema, jsonSchema: CLASSIFY_JSON_SCHEMA, schemaName: 'classification',
    maxTokens: CLASSIFY_MAX_TOKENS, timeoutMs: 20_000, ...net,
  });
  book(clsReserve, cls);
  if (!cls.ok) return fail(null);
  const notable = cls.data.notable
    .map((n) => sanitizeSummary(n))
    .map((n) => (n === null ? null : sanitizeSummary(cutAtWord(n, MAX_NOTABLE_CHARS)))) // truncate first, then sanitize the final string
    .filter((n): n is string => n !== null)
    .slice(0, 5);

  // Only classifier output we can validate (our own refs, enum kinds) reaches the explain prompt, and only as counts.
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const i of cls.data.items) {
    if (!input.refs.has(i.ref) || seen.has(i.ref)) continue;
    seen.add(i.ref);
    counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  }
  const kinds = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ') || 'none';
  const explainUser = `${input.text}\n\nClassification: ${kinds}; substance=${cls.data.ai_substance}`;
  const expReserve = EXPLAIN_MAX_TOKENS + est(EXPLAIN_SYSTEM.length + explainUser.length);
  if (!(await deps.budget(expReserve))) return fail(null);
  const exp = await veniceText({
    model: MODEL_EXPLAIN, system: EXPLAIN_SYSTEM, user: explainUser,
    maxTokens: EXPLAIN_MAX_TOKENS, timeoutMs: 20_000, ...net,
  });
  book(expReserve, exp);
  if (!exp.ok) return fail(null);
  const summary = sanitizeSummary(exp.text);
  if (!summary) return fail(MODEL_EXPLAIN);

  return { aiOk: true, summary, notable, aiSubstance: cls.data.ai_substance, model: MODEL_EXPLAIN, tokens, refundable };
}
