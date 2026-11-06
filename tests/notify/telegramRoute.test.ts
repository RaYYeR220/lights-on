import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getDb } from '@/lib/db';
import { createNightlyShift, insertNight, updateShift, upsertProject } from '@/lib/db/queries';
import { subscriptions } from '@/lib/db/schema';

const resolveBackerProjectIds = vi.fn<(addrs: string[], deps: { db: unknown }) => Promise<number[]>>();
vi.mock('@/lib/backer', async (orig) => ({ ...(await orig<typeof import('@/lib/backer')>()), resolveBackerProjectIds }));
const { POST } = await import('@/app/api/telegram/route');

const ADDR = '0x' + 'ab'.repeat(20);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'DATABASE_URL', 'VENICE_API_KEY']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('telegram route: /brief for an address follow', () => {
  it('resolves the followed wallet to its projects, like the nightly fan-out', async () => {
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_WEBHOOK_SECRET: 'whsec', DATABASE_URL: 'pglite://memory' });
    delete process.env.VENICE_API_KEY;

    const corvo = await upsertProject(db, { slug: 'corvo-edge', name: 'Corvo Edge', source: 'vibestarter' });
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: new Date('2026-11-06T05:00:00Z'), planned: 1 });
    await insertNight(db, { projectId: corvo.id, night: '2026-11-06', shiftId: shift.id, status: 'shipped', observed: true, summary: 'Shipped the pools page.' });
    await updateShift(db, shift.id, { finishedAt: new Date('2026-11-06T05:30:00Z'), status: 'attested' });
    // subscribed through /b/<address> only: no project ids, one address
    await db.insert(subscriptions).values({ channel: 'telegram', target: '77', addresses: [ADDR], projectIds: [] });
    resolveBackerProjectIds.mockResolvedValue([corvo.id]);

    const sent: { chat_id: unknown; text: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response('{"ok":true}', { status: 200 });
    }));
    const res = await POST(new Request('http://localhost/api/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'whsec', 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 77, type: 'private' }, text: '/brief' } }),
    }));
    expect(res.status).toBe(200);
    expect(resolveBackerProjectIds).toHaveBeenCalledWith([ADDR], expect.objectContaining({ db }));
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe('77');
    expect(sent[0].text).toContain('Corvo Edge');
    expect(sent[0].text).not.toContain('You follow nothing yet');
  });
});
