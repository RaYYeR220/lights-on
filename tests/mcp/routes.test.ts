import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { insertNight, upsertProject } from '@/lib/db/queries';
import { GET as projectsGET } from '@/app/api/v1/projects/route';
import { GET as projectGET } from '@/app/api/v1/projects/[slug]/route';
import { GET as nightsGET } from '@/app/api/v1/projects/[slug]/nights/route';
import { POST as watchPOST } from '@/app/api/v1/watch/route';
import { GET as openapiGET } from '@/app/api/openapi.json/route';
import { GET as llmsGET } from '@/app/llms.txt/route';
import { GET as regGET } from '@/app/.well-known/agent-registration.json/route';
import { POST as mcpPOST } from '@/app/api/mcp/route';

const saved = { ...process.env };
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeAll(async () => {
  process.env.DATABASE_URL = 'pglite://memory';
  process.env.INTERNAL_RUN_TOKEN = 'route-test-token';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://lights.test';
  delete process.env.WATCHER_AGENT_ID;
  const db = await getDb();
  await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  const p = await upsertProject(db, { slug: 'revoke-cash', name: 'Revoke Cash', source: 'base' });
  const today = new Date().toISOString().slice(0, 10);
  await insertNight(db, { projectId: p.id, night: today, status: 'shipped', observed: true, signals: { reasons: ['repo.release'] }, attestationUid: '0xuid' });
});
afterAll(() => { process.env = { ...saved }; });

const body = async (r: Response) => JSON.parse(await r.text());

describe('REST', () => {
  it('GET /projects: cached, CORS, shape', async () => {
    const r = await projectsGET(new Request('http://x/api/v1/projects?with=lastNight,history'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, s-maxage=300');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const b = await body(r);
    expect(b.projects[0]).toMatchObject({ slug: 'revoke-cash', status: 'shipped', bay: 1 });
    expect(b.projects[0].history).toHaveLength(90);
  });

  it('GET /projects/[slug] and /nights; 404 and 400 use fixed codes', async () => {
    expect((await projectGET(new Request('http://x'), slugCtx('revoke-cash'))).status).toBe(200);
    const nf = await projectGET(new Request('http://x'), slugCtx('nope'));
    expect(nf.status).toBe(404);
    expect(await body(nf)).toEqual({ error: 'not_found' });
    expect(nf.headers.get('cache-control')).toBe('no-store');
    const n = await nightsGET(new Request('http://x/api/v1/projects/revoke-cash/nights'), slugCtx('revoke-cash'));
    expect((await body(n)).nights).toHaveLength(1);
    const bad = await nightsGET(new Request('http://x/api/v1/projects/revoke-cash/nights?from=abc'), slugCtx('revoke-cash'));
    expect(bad.status).toBe(400);
  });

  it('POST /watch with a private IP -> 400 blocked_url; malformed body -> 400', async () => {
    const mk = (b: string) => new Request('http://x/api/v1/watch', { method: 'POST', body: b, headers: { 'x-real-ip': '5.5.5.5' } });
    const r = await watchPOST(mk(JSON.stringify({ liveUrl: 'http://169.254.169.254/' })));
    expect(r.status).toBe(400);
    expect(await body(r)).toEqual({ error: 'blocked_url' });
    expect((await watchPOST(mk('not json'))).status).toBe(400);
  });
});

describe('static surfaces', () => {
  it('openapi.json is 3.1 and documents every route', async () => {
    const spec = await body(openapiGET());
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/briefing/{address}', '/api/v1/evidence/{hash}', '/api/v1/projects', '/api/v1/projects/{slug}',
      '/api/v1/projects/{slug}/nights', '/api/v1/watch',
    ]);
  });

  it('llms.txt is text/plain with rules and endpoints', async () => {
    const r = llmsGET();
    expect(r.headers.get('content-type')).toContain('text/plain');
    const t = await r.text();
    expect(t).toContain('https://lights.test/api/mcp');
    expect(t).toContain('Precedence is shipped');
  });

  it('agent-registration.json follows ERC-8004 and omits agentId when unset', async () => {
    const j = await body(regGET());
    expect(j.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    expect(j.image).toBe('https://lights.test/icon.png');
    expect(j.services.map((s: { name: string }) => s.name)).toEqual(['web', 'MCP', 'REST']);
    expect(j.registrations).toEqual([{ agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }]);
    process.env.WATCHER_AGENT_ID = '42';
    expect((await body(regGET())).registrations[0].agentId).toBe(42);
    delete process.env.WATCHER_AGENT_ID;
  });
});

describe('MCP', () => {
  const rpc = (method: string, params: unknown, id = 1) =>
    mcpPOST(new Request('http://x/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }));
  const parse = async (r: Response) => {
    const t = await r.text();
    const line = t.startsWith('{') ? t : (t.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
    return JSON.parse(line);
  };

  it('tools/list shows the six tools', async () => {
    const j = await parse(await rpc('tools/list', {}));
    expect(j.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ['get_briefing', 'get_night', 'get_project', 'is_still_shipping', 'list_projects', 'watch_project'],
    );
  });

  it('is_still_shipping returns structured content; unknown slug is a tool error', async () => {
    const ok = await parse(await rpc('tools/call', { name: 'is_still_shipping', arguments: { slug: 'revoke-cash' } }));
    expect(ok.result.structuredContent).toMatchObject({ slug: 'revoke-cash', status: 'shipped', verifiedBy: 'EAS on Base' });
    const bad = await parse(await rpc('tools/call', { name: 'is_still_shipping', arguments: { slug: 'nope' } }));
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0].text)).toEqual({ error: 'not_found' });
  });
});
