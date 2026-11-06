import { describe, it, expect, afterEach } from 'vitest';
import { GET as dispatchGET } from '@/app/api/shift/dispatch/route';
import { POST as runPOST } from '@/app/api/shift/run/route';
import { GET as liveGET } from '@/app/api/shift/live/route';
import * as liveRoute from '@/app/api/shift/live/route';
import fs from 'node:fs';
import path from 'node:path';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['CRON_SECRET', 'INTERNAL_RUN_TOKEN']) {
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

  it('vercel.json schedules the dispatch cron at 05:00 UTC', () => {
    const v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8'));
    expect(v).toEqual({ crons: [{ path: '/api/shift/dispatch', schedule: '0 5 * * *' }] });
  });
});
