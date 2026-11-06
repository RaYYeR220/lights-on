import { describe, it, expect, afterEach } from 'vitest';
import { GET as dispatchGET } from '@/app/api/shift/dispatch/route';
import { POST as runPOST } from '@/app/api/shift/run/route';
import { GET as liveGET } from '@/app/api/shift/live/route';
import { GET as staleGET } from '@/app/api/shift/finalize-stale/route';
import * as liveRoute from '@/app/api/shift/live/route';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getDb } from '@/lib/db';
import { upsertProject } from '@/lib/db/queries';
import { liveRuns } from '@/lib/db/schema';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['CRON_SECRET', 'INTERNAL_RUN_TOKEN', 'DATABASE_URL']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const body = async (r: Response) => JSON.parse(await r.text());

describe('shift routes: auth and input', () => {
  it('dispatch: 503 when CRON_SECRET is unset, 401 on a wrong bearer', async () => {
    delete process.env.CRON_SECRET;
    const r0 = await dispatchGET(new Request('http://localhost/api/shift/dispatch', { headers: { authorization: 'Bearer x' } }));
    expect(r0.status).toBe(503);
    expect(await body(r0)).toEqual({ error: 'not_configured' });
    process.env.CRON_SECRET = 'cron-secret-value';
    const r1 = await dispatchGET(new Request('http://localhost/api/shift/dispatch'));
    expect(r1.status).toBe(401);
    const r2 = await dispatchGET(new Request('http://localhost/api/shift/dispatch', { headers: { authorization: 'Bearer nope' } }));
    expect(r2.status).toBe(401);
    expect(await body(r2)).toEqual({ error: 'unauthorized' });
  });

  it('run: 401 without the internal token, 400 on a bad body', async () => {
    process.env.INTERNAL_RUN_TOKEN = 'internal-token-value';
    const r1 = await runPOST(new Request('http://localhost/api/shift/run', { method: 'POST', body: '{}' }));
    expect(r1.status).toBe(401);
    const r2 = await runPOST(new Request('http://localhost/api/shift/run', {
      method: 'POST', headers: { 'x-internal-token': 'internal-token-value' }, body: '{"projectId":"x"}',
    }));
    expect(r2.status).toBe(400);
    expect(await body(r2)).toEqual({ error: 'bad_request' });
  });

  it('live: 400 on a missing or malformed slug, never echoing input', async () => {
    const r1 = await liveGET(new Request('http://localhost/api/shift/live'));
    expect(r1.status).toBe(400);
    const r2 = await liveGET(new Request('http://localhost/api/shift/live?project=%3Cscript%3E'));
    expect(r2.status).toBe(400);
    expect(await r2.text()).not.toContain('script');
    expect(liveRoute.runtime).toBe('nodejs');
    expect(liveRoute.maxDuration).toBe(120);
  });

  it('live: 503 misconfigured when INTERNAL_RUN_TOKEN (the requester-hash salt) is unset', async () => {
    delete process.env.INTERNAL_RUN_TOKEN;
    const r = await liveGET(new Request('http://localhost/api/shift/live?project=alpha'));
    expect(r.status).toBe(503);
    expect(await body(r)).toEqual({ error: 'misconfigured' });
  });

  it('live: hidden and unknown projects are 404 (no reservation made)', async () => {
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    await upsertProject(db, { slug: 'secret-proj', name: 'S', source: 'community', hidden: true, liveUrl: 'https://s.example' });
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.INTERNAL_RUN_TOKEN = 'internal-token-value';
    for (const slug of ['secret-proj', 'nope']) {
      const r = await liveGET(new Request(`http://localhost/api/shift/live?project=${slug}`));
      expect(r.status).toBe(404);
      expect(await body(r)).toEqual({ error: 'not_found' });
    }
    expect(await db.select().from(liveRuns)).toHaveLength(0);
  });

  it('finalize-stale: 503 when CRON_SECRET is unset, 401 on a wrong bearer', async () => {
    delete process.env.CRON_SECRET;
    expect((await staleGET(new Request('http://localhost/api/shift/finalize-stale'))).status).toBe(503);
    process.env.CRON_SECRET = 'cron-secret-value';
    const r = await staleGET(new Request('http://localhost/api/shift/finalize-stale', { headers: { authorization: 'Bearer nope' } }));
    expect(r.status).toBe(401);
    expect(await body(r)).toEqual({ error: 'unauthorized' });
  });

  it('vercel.json: dispatch at 05:00 UTC, stale recovery at 06:00 UTC', () => {
    const v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8'));
    expect(v).toEqual({
      crons: [
        { path: '/api/shift/dispatch', schedule: '0 5 * * *' },
        { path: '/api/shift/finalize-stale', schedule: '0 6 * * *' },
      ],
    });
  });
});
