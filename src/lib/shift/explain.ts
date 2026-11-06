import { z } from 'zod';
import type { Decision, EvidenceBundle, Status } from '@/lib/types';
import { veniceJSON, veniceText, type FetchLike } from '@/lib/ai/venice';
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
  tokens: number;
}
export interface ExplainDeps {
  budget: (n: number) => Promise<boolean>;
  fetchImpl?: FetchLike;
  apiKey?: string;
}

const BANNED = /\b(scam|rug|dead|abandoned|fraud)\b/i;
const MAX_SUMMARY = 280;
const CLASSIFY_MAX_TOKENS = 700;
const EXPLAIN_MAX_TOKENS = 300;

const ClassifySchema = z.object({
  items: z.array(z.object({ ref: z.string(), kind: z.enum(['feature', 'fix', 'refactor', 'docs', 'deps', 'chore', 'unclear']) })),
  ai_substance: z.enum(['substantive', 'mostly_cosmetic', 'unclear']),
  notable: z.array(z.string().max(120)).max(5),
});

/** Plain text only: markdown, HTML and URLs stripped, <= 280 chars, null if empty or a banned word appears. */
export function sanitizeSummary(s: string): string | null {
  let t = String(s ?? '');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  t = t.replace(/[*_#`]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_SUMMARY) {
    const cut = t.slice(0, MAX_SUMMARY);
    const sp = cut.lastIndexOf(' ');
    t = (sp > 0 && t[MAX_SUMMARY] !== ' ' ? cut.slice(0, sp) : cut).trim();
  }
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

function scrub(s: string): string {
  return s.split(UNTRUSTED_CLOSE).join('').split(UNTRUSTED_OPEN).join('');
}
const clip = (s: string, n: number) => scrub(s).replace(/\s+/g, ' ').trim().slice(0, n);

function buildInput(b: EvidenceBundle, d: Decision): { text: string; empty: boolean } {
  const repo = b.sources.repo?.facts ?? null;
  const live = b.sources.liveapp?.facts ?? null;
  const chain = b.sources.chain?.facts ?? null;
  const lines: string[] = [];
  let count = 0;

  for (const c of repo?.commits ?? []) {
    count++;
    const files = c.files && c.files.length ? ` files=[${c.files.slice(0, 30).map((f) => clip(f, 200)).join(', ')}]` : '';
    lines.push(`commit:${clip(c.sha, 12)} kind=${c.kind} "${clip(c.message.split('\n')[0] ?? '', 200)}"${files}`);
  }
  for (const r of repo?.releases ?? []) {
    count++;
    lines.push(`release:${clip(r.tag, 80)} name="${clip(r.name ?? '', 120)}"`);
  }
  if (live?.newDeploy) {
    count++;
    lines.push('deploy: the live app has a new deployment');
  }
  const added = (live?.textDelta?.added ?? []).slice(0, 10);
  const removed = (live?.textDelta?.removed ?? []).slice(0, 10);
  if (added.length || removed.length) {
    count++;
    lines.push('site_text:');
    for (const a of added) lines.push(`  added: ${clip(a, 200)}`);
    for (const r of removed) lines.push(`  removed: ${clip(r, 200)}`);
  }
  const nd = chain?.newDeployments.length ?? 0;
  if (nd > 0) {
    count++;
    lines.push(`chain: ${nd} new contract deployment(s)`);
  }

  const text = [
    `Status (decided by fixed rules, do not contradict): ${d.status}`,
    `Reasons: ${d.reasons.join(', ')}`,
    UNTRUSTED_OPEN,
    lines.join('\n') || '(nothing recorded)',
    UNTRUSTED_CLOSE,
  ].join('\n');
  return { text, empty: count === 0 };
}

const est = (chars: number) => Math.ceil(chars / 4);

/** Explains an already-decided night. Never changes the status; any failure -> aiOk false, summary null. */
export async function explainNight(b: EvidenceBundle, d: Decision, deps: ExplainDeps): Promise<Explanation> {
  const fail = (tokens: number, model: string | null): Explanation => ({ aiOk: false, summary: null, notable: [], aiSubstance: null, model, tokens });
  const input = buildInput(b, d);

  if (input.empty) {
    return { aiOk: true, summary: sanitizeSummary(TEMPLATES[d.status]), notable: [], aiSubstance: null, model: null, tokens: 0 };
  }

  let tokens = 0;
  const net = { fetchImpl: deps.fetchImpl, apiKey: deps.apiKey };

  const classifyUser = `Items to classify:\n${input.text}`;
  if (!(await deps.budget(CLASSIFY_MAX_TOKENS + est(CLASSIFY_SYSTEM.length + classifyUser.length)))) return fail(0, null);
  const cls = await veniceJSON({
    model: MODEL_CLASSIFY, system: CLASSIFY_SYSTEM, user: classifyUser,
    schema: ClassifySchema, jsonSchema: CLASSIFY_JSON_SCHEMA, schemaName: 'classification',
    maxTokens: CLASSIFY_MAX_TOKENS, timeoutMs: 20_000, ...net,
  });
  if (!cls.ok) return fail(tokens, null);
  tokens += cls.tokens;
  const notable = cls.data.notable.map((n) => sanitizeSummary(n)).filter((n): n is string => n !== null);

  const kinds = cls.data.items.map((i) => `${clip(i.ref, 100)}=${i.kind}`).join('; ') || 'none';
  const explainUser = `${input.text}\n\nClassification: ${kinds}; substance=${cls.data.ai_substance}`;
  if (!(await deps.budget(EXPLAIN_MAX_TOKENS + est(EXPLAIN_SYSTEM.length + explainUser.length)))) return fail(tokens, null);
  const exp = await veniceText({
    model: MODEL_EXPLAIN, system: EXPLAIN_SYSTEM, user: explainUser,
    maxTokens: EXPLAIN_MAX_TOKENS, timeoutMs: 20_000, ...net,
  });
  if (!exp.ok) return fail(tokens, null);
  tokens += exp.tokens;
  const summary = sanitizeSummary(exp.text);
  if (!summary) return fail(tokens, MODEL_EXPLAIN);

  return { aiOk: true, summary, notable, aiSubstance: cls.data.ai_substance, model: MODEL_EXPLAIN, tokens };
}
