import { sql, type SQL } from 'drizzle-orm';
import { sanitizeSummary } from '@/lib/shift/explain';
import type { Status } from '@/lib/types';

/** What a night row needs for the "what shipped" lines. */
export interface WorkRow {
  status: Status;
  summary: string | null;
  notable: unknown;
  aiModel: string | null;
  reasons: unknown;
  /** From workSql(): up to 8 non-bot code commit subjects and 2 releases of the night's evidence. */
  work: { commits?: unknown; releases?: unknown } | null;
}

/**
 * SQL that pulls the few evidence fields the "what shipped" lines use (non-bot code commit subjects, releases)
 * out of the bundle server side, so the whole bundle never travels.
 */
export function workSql(hash: SQL): SQL {
  return sql`(
    SELECT jsonb_build_object(
      'commits', (
        SELECT coalesce(jsonb_agg(c.m ORDER BY c.o), '[]'::jsonb) FROM (
          SELECT t.el ->> 'message' AS m, t.o
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.bundle #> '{sources,repo,facts,commits}') = 'array'
            THEN e.bundle #> '{sources,repo,facts,commits}' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(el, o)
          WHERE t.el ->> 'kind' = 'code' AND coalesce((t.el ->> 'authorIsBot')::boolean, false) = false
          ORDER BY t.o LIMIT 8
        ) c
      ),
      'releases', (
        SELECT coalesce(jsonb_agg(r.v ORDER BY r.o), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('name', t.el ->> 'name', 'tag', t.el ->> 'tag') AS v, t.o
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.bundle #> '{sources,repo,facts,releases}') = 'array'
            THEN e.bundle #> '{sources,repo,facts,releases}' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(el, o)
          ORDER BY t.o LIMIT 2
        ) r
      )
    ) FROM evidence e WHERE e.hash = ${hash}
  )`;
}

const BANNED = /\b(scam|rug|dead|abandoned|fraud)\b/i;

/** Cut to <= n chars at a word boundary, with an ellipsis when cut. */
export function clip(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(-]+$/, '')}…`;
}

/** AI-written lines (summary / notable) go through the same sanitizer the shift uses. */
export function aiLine(s: unknown, max = 140): string | null {
  if (typeof s !== 'string') return null;
  const t = sanitizeSummary(s);
  return t ? clip(t, max) : null;
}

/** A commit subject as plain text: first line, no HTML, no URLs, no markdown emphasis; merges skipped. */
export function commitLine(s: unknown, max = 100): string | null {
  if (typeof s !== 'string') return null;
  let t = s.split('\n')[0] ?? '';
  if (/^Merge (pull request|branch|remote-tracking|tag)\b/i.test(t)) return null;
  t = t.replace(/<[^>]*>/g, ' ').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/[`*_]{1,3}/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || BANNED.test(t)) return null;
  return clip(t, max);
}

function releaseLine(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null;
  const { name, tag } = r as { name?: unknown; tag?: unknown };
  const n = typeof name === 'string' && name.trim() ? name.trim() : null;
  const t = typeof tag === 'string' && tag.trim() ? tag.trim() : null;
  const line = n ?? (t ? `Release ${t}` : null);
  return line ? commitLine(line) : null;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Up to `max` short lines of real work behind a shipped/building night; nothing for other statuses, never invented. */
export function whatShipped(row: WorkRow | undefined, max = 2): string[] {
  if (!row || (row.status !== 'shipped' && row.status !== 'building')) return [];
  const out: string[] = [];
  const push = (s: string | null) => {
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const n of asArray(row.notable)) push(aiLine(n));
  // A summary counts only when a model wrote it; the no-AI fallbacks are generic templates.
  if (out.length === 0 && row.aiModel) push(aiLine(row.summary));
  if (row.status === 'shipped') {
    for (const r of asArray(row.work?.releases)) push(releaseLine(r));
    const reasons = asArray(row.reasons);
    if (reasons.includes('liveapp.new_deploy')) push('New deploy seen on the live app');
    if (reasons.includes('chain.new_deployment')) push('New contract deployment');
  }
  for (const c of asArray(row.work?.commits)) push(commitLine(c));
  return out.slice(0, max);
}
