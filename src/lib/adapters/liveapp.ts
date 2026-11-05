import { createHash } from 'node:crypto';
import { parse, HTMLElement, TextNode, type Node } from 'node-html-parser';
import { safeFetch, BlockedUrl, type SafeFetchResult } from '@/lib/net/safeFetch';
import type { AdapterResult, LiveAppFacts } from '@/lib/types';

export interface LiveAppDeps {
  fetch?: (url: string) => Promise<SafeFetchResult>;
  /** Visible text from the previous run, if the caller kept it; needed for textDelta. */
  prevText?: string;
  retryDelayMs?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const NEXT_ASSET = /\/_next\/static\/[^"'\s)<>\\]+/g;
const VITE_ASSET = /\/assets\/[^"'\s)<>\\]+-[A-Za-z0-9_-]{6,}\.(?:js|css)/g;
const BUILD_ID_RES = [/"buildId"\s*:\s*"([^"]+)"/, /\\"b\\"\s*:\s*\\"([^"\\]+)\\"/];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);

function collectText(node: Node, out: string[]): void {
  if (node instanceof TextNode) {
    out.push(node.text);
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (SKIP_TAGS.has(node.tagName)) return;
  out.push(' ');
  for (const c of node.childNodes) collectText(c, out);
  out.push(' ');
}

function visibleText(html: string): string {
  const root = parse(html, { comment: false });
  const parts: string[] = [];
  collectText(root, parts);
  return parts.join('').replace(/\d{6,}/g, '').replace(/\s+/g, ' ').trim();
}

export function extractFingerprint(
  html: string,
  _baseUrl: string,
): { deployFingerprint: string | null; textHash: string | null; title: string | null; text: string } {
  const assets = new Set<string>();
  for (const re of [NEXT_ASSET, VITE_ASSET]) {
    for (const m of html.matchAll(re)) assets.add(m[0].split('?')[0]);
  }
  for (const re of BUILD_ID_RES) {
    const m = html.match(re);
    if (m) assets.add(`build:${m[1]}`);
  }
  const deployFingerprint = assets.size ? sha256([...assets].sort().join('\n')) : null;

  const text = visibleText(html);
  const textHash = text ? sha256(text) : null;

  let title: string | null = null;
  const t = parse(html, { comment: false }).querySelector('title');
  if (t) title = t.text.replace(/\s+/g, ' ').trim().slice(0, 300) || null;

  return { deployFingerprint, textHash, title, text };
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_ITEMS = 20;
const MAX_LEN = 200;

function computeDelta(prevText: string, text: string): NonNullable<LiveAppFacts['textDelta']> {
  const before = new Set(sentences(prevText));
  const after = new Set(sentences(text));
  const added = [...after].filter((s) => !before.has(s));
  const removed = [...before].filter((s) => !after.has(s));
  const changedChars = [...added, ...removed].reduce((n, s) => n + s.length, 0);
  const cap = (xs: string[]) => xs.slice(0, MAX_ITEMS).map((s) => s.slice(0, MAX_LEN));
  return { added: cap(added), removed: cap(removed), changedChars };
}

function isHtml(res: SafeFetchResult): boolean {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('html')) return true;
  if (ct.includes('json') || ct.includes('xml') || ct.startsWith('application/') || ct.startsWith('image/')) return false;
  return /^\s*(<!doctype html|<html)/i.test(res.body);
}

const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function checkLiveAppDetailed(
  url: string,
  prev: LiveAppFacts | null,
  deps: LiveAppDeps = {},
): Promise<{ result: AdapterResult<LiveAppFacts>; text: string | null }> {
  const doFetch = deps.fetch ?? ((u: string) => safeFetch(u));
  const base: LiveAppFacts = {
    url,
    finalUrl: null,
    httpStatus: null,
    up: false,
    latencyMs: null,
    deployFingerprint: null,
    textHash: null,
    title: null,
    bytes: null,
    newDeploy: false,
    textDelta: null,
  };
  const mkResult = (facts: LiveAppFacts | null, ok: boolean, error?: string, calls?: number): AdapterResult<LiveAppFacts> => ({
    source: 'liveapp',
    tier: 'verified',
    ok,
    facts,
    ...(error ? { error } : {}),
    ...(calls ? { calls } : {}),
  });

  let last: SafeFetchResult | null = null;
  let lastErr: string | undefined;
  let attempts = 0;
  for (let i = 0; i < 2; i++) {
    attempts++;
    try {
      const res = await doFetch(url);
      last = res;
      lastErr = undefined;
      if (res.status < 500) break;
      lastErr = `http ${res.status}`;
    } catch (e) {
      if (e instanceof BlockedUrl) return { result: mkResult(null, false, `blocked: ${e.message}`, attempts), text: null };
      last = null;
      lastErr = (e as Error).message || 'fetch failed';
    }
    if (i === 0) await wait(deps.retryDelayMs ?? 1000);
  }

  if (!last || last.status >= 500) {
    const facts: LiveAppFacts = { ...base, httpStatus: last?.status ?? null, finalUrl: last?.finalUrl ?? null };
    return { result: mkResult(facts, true, lastErr, attempts), text: null };
  }

  const res = last;
  let deployFingerprint: string | null;
  let textHash: string | null = null;
  let title: string | null = null;
  let text: string | null = null;
  if (isHtml(res)) {
    const fp = extractFingerprint(res.body, res.finalUrl);
    ({ deployFingerprint, textHash, title, text } = fp);
  } else {
    deployFingerprint = sha256(res.body);
  }

  const newDeploy =
    !!prev &&
    (prev.deployFingerprint !== deployFingerprint ||
      (prev.deployFingerprint === null && deployFingerprint === null && prev.textHash !== textHash));

  const facts: LiveAppFacts = {
    ...base,
    finalUrl: res.finalUrl,
    httpStatus: res.status,
    up: true,
    latencyMs: res.latencyMs,
    deployFingerprint,
    textHash,
    title,
    bytes: Buffer.byteLength(res.body),
    newDeploy,
    textDelta: prev && deps.prevText !== undefined && text !== null ? computeDelta(deps.prevText, text) : null,
  };
  return { result: mkResult(facts, true, undefined, attempts), text };
}

export async function checkLiveApp(
  url: string,
  prev: LiveAppFacts | null,
  deps?: LiveAppDeps,
): Promise<AdapterResult<LiveAppFacts>> {
  return (await checkLiveAppDetailed(url, prev, deps)).result;
}
