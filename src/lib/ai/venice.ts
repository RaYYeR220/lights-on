import { fetch as undiciFetch } from 'undici';
import type { z } from 'zod';
import { safeErrorCode } from '@/lib/net/redact';

export const VENICE_URL = 'https://api.venice.ai/api/v1/chat/completions';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface Base {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to undici fetch. */
  fetchImpl?: FetchLike;
  /** Defaults to process.env.VENICE_API_KEY. */
  apiKey?: string;
}
export type VeniceJSONOpts<T> = Base & { schema: z.ZodType<T>; jsonSchema: object; schemaName?: string };
export type VeniceResult<K extends string, T> = ({ ok: true; tokens: number } & { [P in K]: T }) | { ok: false; error: string };

/** One Venice chat call. Returns message content + token usage, or a fixed error code (never a message, never the key). */
async function call(
  o: Base,
  responseFormat?: object,
): Promise<{ ok: true; content: string; tokens: number } | { ok: false; error: string }> {
  const key = o.apiKey ?? process.env.VENICE_API_KEY;
  if (!key) return { ok: false, error: 'no_key' };
  const f = o.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  try {
    const res = await f(VENICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
        max_tokens: o.maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        venice_parameters: { include_venice_system_prompt: false },
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    let body: { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: unknown } };
    try {
      body = JSON.parse(await res.text());
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'empty' };
    const t = body?.usage?.total_tokens;
    return { ok: true, content, tokens: typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : 0 };
  } catch (e) {
    return { ok: false, error: safeErrorCode(e) };
  }
}

export async function veniceJSON<T>(o: VeniceJSONOpts<T>): Promise<VeniceResult<'data', T>> {
  const r = await call(o, {
    type: 'json_schema',
    json_schema: { name: o.schemaName ?? 'result', strict: true, schema: o.jsonSchema },
  });
  if (!r.ok) return r;
  let raw: unknown;
  try {
    raw = JSON.parse(r.content);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const parsed = o.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'schema' };
  return { ok: true, data: parsed.data, tokens: r.tokens };
}

export async function veniceText(o: Base): Promise<VeniceResult<'text', string>> {
  const r = await call(o);
  if (!r.ok) return r;
  return { ok: true, text: r.content, tokens: r.tokens };
}
