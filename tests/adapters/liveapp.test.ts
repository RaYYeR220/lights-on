import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkLiveApp, extractFingerprint } from '@/lib/adapters/liveapp';
import { BlockedUrl } from '@/lib/net/safeFetch';
import type { SafeFetchResult } from '@/lib/net/safeFetch';
import type { LiveAppFacts } from '@/lib/types';

const fx = (n: string) => readFileSync(path.join(__dirname, '..', 'fixtures', 'html', `${n}.html`), 'utf8');
const URL_ = 'https://app.example.test/';

const resp = (body: string, over: Partial<SafeFetchResult> = {}): SafeFetchResult => ({
  status: 200,
  finalUrl: URL_,
  headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
  body,
  truncated: false,
  latencyMs: 42,
  ...over,
});
const serve = (body: string, over?: Partial<SafeFetchResult>) => ({ fetch: async () => resp(body, over), retryDelayMs: 0 });

async function facts(name: string, prev: LiveAppFacts | null = null, prevText?: string) {
  const r = await checkLiveApp(URL_, prev, { ...serve(fx(name)), prevText });
  expect(r.ok).toBe(true);
  return r.facts!;
}

describe('extractFingerprint', () => {
  it('next app: fingerprint from _next/static assets + build id; text ignores scripts/attrs', () => {
    const r = extractFingerprint(fx('next-app-a'), URL_);
    expect(r.deployFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.title).toBe('Corvo Edge | Prediction markets for builders');
    expect(r.text).toContain('Trade on what ships.');
    expect(r.text).not.toContain('__next_f');
    expect(r.text).not.toContain('nonceAAAA1111');
    expect(r.text).not.toMatch(/\d{6,}/);
  });

  it('static page has no fingerprint, only a text hash', () => {
    const r = extractFingerprint(fx('static-a'), URL_);
    expect(r.deployFingerprint).toBeNull();
    expect(r.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.text).not.toContain('console.log');
    expect(r.text).not.toContain('font:16px');
  });

  it('vite assets: hashed index-<hash>.js changes the fingerprint', () => {
    expect(extractFingerprint(fx('vite-a'), URL_).deployFingerprint).not.toEqual(
      extractFingerprint(fx('vite-b'), URL_).deployFingerprint,
    );
  });
});

describe('checkLiveApp newDeploy', () => {
  it('first sighting (prev null) is never a new deploy, textDelta null', async () => {
    const a = await facts('next-app-a');
    expect(a).toMatchObject({ up: true, httpStatus: 200, newDeploy: false, textDelta: null, latencyMs: 42 });
    expect(a.bytes).toBe(Buffer.byteLength(fx('next-app-a')));
  });

  it('next-app-a vs next-app-b -> newDeploy true', async () => {
    const a = await facts('next-app-a');
    const b = await facts('next-app-b', a);
    expect(b.newDeploy).toBe(true);
    expect(b.deployFingerprint).not.toEqual(a.deployFingerprint);
  });

  it('only CSP nonce + timestamp + request id differ -> newDeploy false (Review Focus 1)', async () => {
    const a = await facts('next-app-a');
    const n = await facts('next-app-a-nonce', a);
    expect(n.deployFingerprint).toEqual(a.deployFingerprint);
    expect(n.newDeploy).toBe(false);
  });

  it('vite-a vs vite-b -> newDeploy true', async () => {
    const a = await facts('vite-a');
    expect((await facts('vite-b', a)).newDeploy).toBe(true);
  });

  it('static-a vs static-b -> newDeploy true via textHash', async () => {
    const a = await facts('static-a');
    expect(a.deployFingerprint).toBeNull();
    const b = await facts('static-b', a);
    expect(b.newDeploy).toBe(true);
    expect(b.textHash).not.toEqual(a.textHash);
  });

  it('identical static page -> newDeploy false', async () => {
    const a = await facts('static-a');
    expect((await facts('static-a', a)).newDeploy).toBe(false);
  });

  it('JSON body -> fingerprint from body sha256, textHash null', async () => {
    const body = '{"status":"ok","version":"1.4.2"}';
    const r = await checkLiveApp(URL_, null, {
      ...serve(body, { headers: new Headers({ 'content-type': 'application/json' }) }),
    });
    const { createHash } = await import('node:crypto');
    expect(r.facts!.deployFingerprint).toBe(createHash('sha256').update(body).digest('hex'));
    expect(r.facts!.textHash).toBeNull();
    const r2 = await checkLiveApp(URL_, r.facts, {
      ...serve('{"status":"ok","version":"1.5.0"}', { headers: new Headers({ 'content-type': 'application/json' }) }),
    });
    expect(r2.facts!.newDeploy).toBe(true);
  });
});

describe('checkLiveApp availability', () => {
  it('500 twice -> up false after exactly 2 attempts', async () => {
    let n = 0;
    const r = await checkLiveApp(URL_, null, {
      retryDelayMs: 0,
      fetch: async () => {
        n++;
        return resp('boom', { status: 500 });
      },
    });
    expect(n).toBe(2);
    expect(r).toMatchObject({ source: 'liveapp', tier: 'verified', ok: true });
    expect(r.facts).toMatchObject({ up: false, httpStatus: 500, newDeploy: false });
  });

  it('500 then 200 -> up true, latency from the successful attempt', async () => {
    let n = 0;
    const r = await checkLiveApp(URL_, null, {
      retryDelayMs: 0,
      fetch: async () => (n++ === 0 ? resp('x', { status: 503, latencyMs: 9000 }) : resp(fx('static-a'), { latencyMs: 77 })),
    });
    expect(r.facts).toMatchObject({ up: true, latencyMs: 77 });
  });

  it('network error twice -> up false, httpStatus null', async () => {
    const r = await checkLiveApp(URL_, null, {
      retryDelayMs: 0,
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(r.facts).toMatchObject({ up: false, httpStatus: null, latencyMs: null });
  });

  it('blocked URL -> ok false, no facts, no retry', async () => {
    let n = 0;
    const r = await checkLiveApp('http://169.254.169.254/', null, {
      retryDelayMs: 0,
      fetch: async () => {
        n++;
        throw new BlockedUrl('address blocked');
      },
    });
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, facts: null });
    expect(r.error).toMatch(/blocked/i);
  });

  it('truncated huge page is still handled', async () => {
    const r = await checkLiveApp(URL_, null, serve(fx('static-a'), { truncated: true }));
    expect(r.facts!.up).toBe(true);
  });
});

describe('textDelta', () => {
  it('lists added/removed sentences', async () => {
    const a = extractFingerprint(fx('static-a'), URL_);
    const b = await facts('static-b', await facts('static-a'), a.text);
    expect(b.textDelta!.added).toContain('Latest entry: varnish is on.');
    expect(b.textDelta!.added).toContain('Launch day is set for spring.');
    expect(b.textDelta!.removed).toContain('Latest entry: sanding the hull.');
    expect(b.textDelta!.changedChars).toBeGreaterThan(0);
  });

  it('caps each item at 200 chars and 20 items', async () => {
    const mk = (s: string) => `<html><body><p>${s}</p></body></html>`;
    const prevHtml = mk('Keep me.');
    const long = 'x'.repeat(500) + '.';
    const many = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(' ');
    const prev = (await checkLiveApp(URL_, null, serve(prevHtml))).facts!;
    const prevText = extractFingerprint(prevHtml, URL_).text;
    const r = await checkLiveApp(URL_, prev, { ...serve(mk(`Keep me. ${long} ${many}`)), prevText });
    const d = r.facts!.textDelta!;
    expect(d.added.length).toBe(20);
    expect(d.added.every((s) => s.length <= 200)).toBe(true);
    expect(d.changedChars).toBeGreaterThan(500);
  });

  it('is null when previous text is unavailable', async () => {
    const a = await facts('static-a');
    expect((await facts('static-b', a)).textDelta).toBeNull();
  });
});

describe('fix round 1', () => {
  const html = (code: number) => ({ retryDelayMs: 0, fetch: async () => resp('nope', { status: code }) });

  it('404 twice -> up false', async () => {
    const r = await checkLiveApp(URL_, null, html(404));
    expect(r.ok).toBe(true);
    expect(r.facts).toMatchObject({ up: false, httpStatus: 404 });
  });

  it.each([401, 403, 429])('%i -> ok false, degraded, never up:false', async (code) => {
    let n = 0;
    const r = await checkLiveApp(URL_, null, { retryDelayMs: 0, fetch: async () => (n++, resp('x', { status: code })) });
    expect(r).toMatchObject({ ok: false, degraded: true, facts: null, error: `blocked_by_site (${code})` });
  });

  it('prev down (null hashes) -> current up -> newDeploy false', async () => {
    const down = (await checkLiveApp(URL_, null, html(500))).facts!;
    expect(down.up).toBe(false);
    expect((await facts('next-app-b', down)).newDeploy).toBe(false);
  });

  it('prev up but hashless -> newDeploy false', async () => {
    const prev = { ...(await facts('static-a')), textHash: null, deployFingerprint: null };
    expect((await facts('static-b', prev)).newDeploy).toBe(false);
  });

  it('pathological 200 KB asset value finishes fast', () => {
    const evil = '/assets/' + 'a-'.repeat(1e5);
    const page = `<html><head><title>t</title><script src="${evil}.js"></script><link href="${evil}.css" rel="modulepreload"></head><body>${evil}</body></html>`;
    const t0 = performance.now();
    extractFingerprint(page, URL_);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('modulepreload / absolute asset URLs count', () => {
    const p = (h: string) => `<html><head><link rel="modulepreload" href="https://cdn.x.test${h}"></head></html>`;
    expect(extractFingerprint(p('/assets/chunk-Abc123xy.js'), URL_).deployFingerprint).not.toBeNull();
    expect(extractFingerprint(p('/assets/logo.png'), URL_).deployFingerprint).toBeNull();
  });
});
