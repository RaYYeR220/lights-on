import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { insertNight, saveEvidence, upsertProject } from '@/lib/db/queries';
import { API_CACHE_TTL_MS, MISS_LIMIT, cached, cachedRead, resetApiCache } from '@/lib/apiCache';
import { ToolError } from '@/lib/mcp/errors';
import { GET as projectsGET } from '@/app/api/v1/projects/route';
import { GET as projectGET } from '@/app/api/v1/projects/[slug]/route';
import { GET as nightsGET } from '@/app/api/v1/projects/[slug]/nights/route';
import { GET as evidenceGET } from '@/app/api/v1/evidence/[hash]/route';
import { POST as mcpPOST } from '@/app/api/mcp/route';
import type { EvidenceBundle } from '@/lib/types';

const saved = { ...process.env };
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const body = async (r: Response) => JSON.parse(await r.text());
const HASH = `0x${'5'.repeat(64)}`;

beforeAll(async () => {
  process.env.DATABASE_URL = 'pglite://memory';
  process.env.INTERNAL_RUN_TOKEN = 'cache-test-token';
  const db = await getDb();
  await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  const p = await upsertProject(db, { slug: 'revoke-cash', name: 'Revoke Cash', source: 'base' });
  const today = new Date().toISOString().slice(0, 10);
  await insertNight(db, { projectId: p.id, night: today, status: 'shipped', observed: true, signals: { reasons: ['repo.release'] } });
  const bundle = { v: 1, rulesVersion: 'r', project: 'revoke-cash', night: 20261106, kind: 'nightly', window: { start: 'a', end: 'b' }, sources: { repo: null, liveapp: null, chain: null, vibestarter: null } } as unknown as EvidenceBundle;
  await saveEvidence(db, HASH, p.id, today, bundle);
});
beforeEach(() => resetApiCache());
afterAll(() => { process.env = { ...saved }; });

describe('process cache', () => {
  it('shares in-flight and cached reads, expires after the TTL, never keeps a failure', async () => {
    const load = vi.fn(async () => ({ n: 1 }));
    const t = 1_000_000;
    const [a, b] = await Promise.all([cached('k', load, API_CACHE_TTL_MS, t), cached('k', load, API_CACHE_TTL_MS, t)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    await cached('k', load, API_CACHE_TTL_MS, t + API_CACHE_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await cached('k', load, API_CACHE_TTL_MS, t + API_CACHE_TTL_MS + 1);
    expect(load).toHaveBeenCalledTimes(2);
    const boom = vi.fn(async () => { throw new Error('db down'); });
    await expect(cached('e', boom, API_CACHE_TTL_MS, t)).rejects.toThrow('db down');
    await expect(cached('e', boom, API_CACHE_TTL_MS, t)).rejects.toThrow('db down');
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it(`a requester gets ${MISS_LIMIT} database reads per 10 min; cached answers are free`, async () => {
    const h = new Headers({ 'x-real-ip': '9.9.9.9' });
    const t = 2_000_000;
    for (let i = 0; i < MISS_LIMIT; i++) await cachedRead(`miss:${i}`, h, async () => i, t);
    await expect(cachedRead('miss:new', h, async () => 0, t)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(await cachedRead('miss:3', h, async () => -1, t)).toBe(3); // a hit is not limited
    expect(await cachedRead('miss:new', new Headers({ 'x-real-ip': '8.8.8.8' }), async () => 7, t)).toBe(7);
    await expect(cachedRead('miss:other', h, async () => 0, t + 10 * 60_000 + 1)).resolves.toBe(0);
  });
});

describe('REST: canonical queries and cached answers', () => {
  it('redirects unknown or reordered params to the canonical URL with a cacheable 308, no DB read', async () => {
    const cases: [string, string][] = [
      ['/api/v1/projects?with=history,lastNight', '/api/v1/projects?with=lastNight,history'],
      ['/api/v1/projects?with=lastNight,history&cb=123', '/api/v1/projects?with=lastNight,history'],
      ['/api/v1/projects?cb=1', '/api/v1/projects'],
      ['/api/v1/projects?with=nope', '/api/v1/projects'],
    ];
    for (const [from, to] of cases) {
      const r = await projectsGET(new Request(`http://x${from}`));
      expect(r.status).toBe(308);
      expect(r.headers.get('location')).toBe(to);
      expect(r.headers.get('cache-control')).toContain('s-maxage');
    }
    expect((await projectsGET(new Request('http://x/api/v1/projects?with=lastNight,history'))).status).toBe(200);
    const one = await projectGET(new Request('http://x/api/v1/projects/revoke-cash?x=1'), slugCtx('revoke-cash'));
    expect([one.status, one.headers.get('location')]).toEqual([308, '/api/v1/projects/revoke-cash']);
    const ns = await nightsGET(new Request('http://x/api/v1/projects/revoke-cash/nights?to=20261106&from=20261101&z=1'), slugCtx('revoke-cash'));
    expect([ns.status, ns.headers.get('location')]).toEqual([308, '/api/v1/projects/revoke-cash/nights?from=20261101&to=20261106']);
    const ev = await evidenceGET(new Request(`http://x/api/v1/evidence/${HASH}?v=2`), { params: Promise.resolve({ hash: HASH }) });
    expect([ev.status, ev.headers.get('location')]).toEqual([308, `/api/v1/evidence/${HASH}`]);
    expect((await evidenceGET(new Request(`http://x/api/v1/evidence/${HASH}`), { params: Promise.resolve({ hash: HASH }) })).status).toBe(200);
  });

  it('a second list call within the TTL is served from memory (REST and MCP share the entry)', async () => {
    const db = await getDb();
    const first = await body(await projectsGET(new Request('http://x/api/v1/projects?with=lastNight,history')));
    expect(first.projects.map((p: { slug: string }) => p.slug)).toEqual(['revoke-cash']);
    expect(first.projects[0].history).toMatch(/^[.SBQDU]{89}S$/);
    await upsertProject(db, { slug: 'later', name: 'Later', source: 'base' });
    const again = await body(await projectsGET(new Request('http://x/api/v1/projects?with=lastNight,history')));
    expect(again).toEqual(first);
    const viaMcp = await mcpPOST(new Request('http://x/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: { history: true } } }),
    }));
    const t = await viaMcp.text();
    const line = t.startsWith('{') ? t : (t.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
    expect(JSON.parse(line).result.structuredContent.projects).toHaveLength(1); // the cached list
    resetApiCache();
    const fresh = await body(await projectsGET(new Request('http://x/api/v1/projects?with=lastNight,history')));
    expect(fresh.projects).toHaveLength(2);
  });

  it('an unknown slug is never cached and answers 404', async () => {
    const r = await projectGET(new Request('http://x/api/v1/projects/nope'), slugCtx('nope'));
    expect(r.status).toBe(404);
    expect(await body(r)).toEqual({ error: 'not_found' });
    expect(new ToolError('x', 1)).toBeInstanceOf(Error);
  });
});
