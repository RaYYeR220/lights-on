import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from '../helpers/db';
import { seedProject } from '../helpers/shift';
import { insertNight, createNightlyShift, updateShift } from '@/lib/db/queries';
import { subscriptions, trancheEvents } from '@/lib/db/schema';
import { getDb, type Db } from '@/lib/db';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildBriefing, templateBriefing, type BriefingProject } from '@/lib/notify/briefing';
import { encodeStartToken, handleTelegramUpdate, parseCommand, HELP_TEXT } from '@/lib/notify/telegram';
import { onShiftFinalized } from '@/lib/notify/send';
import { sendPush, pushPayload } from '@/lib/notify/webpush';
import { POST as telegramPOST } from '@/app/api/telegram/route';
import { POST as subscribePOST, DELETE as subscribeDELETE } from '@/app/api/push/subscribe/route';
import type { NightRow } from '@/lib/db/schema';
import type { Status } from '@/lib/types';

const ADDR = '0x' + 'ab'.repeat(20);

const night = (status: Status, summary: string | null = null): NightRow => ({ status, summary } as unknown as NightRow);
const proj = (name: string, status: Status | null, summary: string | null = null, openWindow: BriefingProject['openWindow'] = null): BriefingProject => ({
  slug: name.toLowerCase(), name, night: status ? night(status, summary) : null,
  record: { streak: 1, lit30: 12, lastShip: null }, openWindow,
});

describe('parseCommand', () => {
  const tok = encodeStartToken({ a: ADDR, p: 'corvo-edge' });
  it.each([
    ['/start ' + tok, { cmd: 'start', address: ADDR, slug: 'corvo-edge' }],
    ['/start ' + encodeStartToken({ p: 'x1' }), { cmd: 'start', slug: 'x1' }],
    ['/watch Corvo-Edge', { cmd: 'watch', slug: 'corvo-edge' }],
    ['/watch@LightsBot corvo', { cmd: 'watch', slug: 'corvo' }],
    ['/address ' + ADDR.toUpperCase().replace('0X', '0x'), { cmd: 'address', address: ADDR }],
    ['/address 0x123', { cmd: 'help' }],
    ['/watch', { cmd: 'help' }],
    ['/watch ../etc', { cmd: 'help' }],
    ['/brief', { cmd: 'brief' }],
    ['/stop', { cmd: 'stop' }],
    ['hello', { cmd: 'help' }],
    ['/nope', { cmd: 'help' }],
    ['', { cmd: 'help' }],
  ])('%s', (text, want) => {
    expect(parseCommand(text)).toEqual(want);
  });

  it('/start with a bad token falls back to help', () => {
    expect(parseCommand('/start !!!')).toEqual({ cmd: 'help' });
    expect(parseCommand('/start ' + Buffer.from('not json').toString('base64url'))).toEqual({ cmd: 'help' });
    expect(parseCommand('/start ' + Buffer.from('{"a":"0x12"}').toString('base64url'))).toEqual({ cmd: 'help' });
    expect(parseCommand('/start ' + Buffer.from('{}').toString('base64url'))).toEqual({ cmd: 'help' });
  });
});

describe('buildBriefing', () => {
  const projects = [
    proj('Alpha', 'shipped', 'Released v2 with a new checkout flow.'),
    proj('Beta', 'building', 'Code changes landed.'),
    proj('Gamma', 'quiet'),
    proj('Delta', 'down'),
    proj('Epsilon', null),
  ];
  const input = { projects, date: 20261106 };

  it('template mentions every followed project once, with counts', async () => {
    const r = await buildBriefing(input, {});
    expect(r.aiOk).toBe(false);
    for (const p of projects) expect(r.text.split(p.name).length - 1).toBe(1);
    expect(r.text).toMatch(/^Lights On · night 2026-11-06/);
    expect(r.text).toContain('Shipped (1): Alpha');
    expect(r.text).toContain('Down (1): Delta');
    expect(r.text.length).toBeLessThanOrEqual(1200);
  });

  it('lists upcoming challenge windows', async () => {
    const corvo = proj('Corvo Edge', 'quiet', null, {
      index: 2, status: 'open', requestedAt: null, windowEndsAt: '2026-11-07T12:00:00.000Z', amountPaidWei: null,
    });
    const r = await buildBriefing({ projects: [corvo], date: 20261106 }, { now: () => new Date('2026-11-06T05:00:00Z') });
    expect(r.text).toContain('Corvo Edge — T2 window closes in 31 h');
  });

  it('stays within 1200 chars for many projects', () => {
    const many = Array.from({ length: 300 }, (_, i) => proj(`Project${i}`, 'shipped', 'x'.repeat(200)));
    const t = templateBriefing({ projects: many, date: 20261106 }, Date.now());
    expect(t.length).toBeLessThanOrEqual(1200);
    expect(t).toMatch(/\+\d+ more/);
  });

  const ai = (text: string, ok = true) => ({
    budget: vi.fn(async () => true),
    apiKey: 'k',
    fetchImpl: vi.fn(async () => ({
      ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
    })),
  });
  const template = () => buildBriefing(input, {}).then((r) => r.text);

  it('uses the AI text when it keeps every name', async () => {
    const t = await template();
    const a = ai(t.replace('Released v2', 'Released v2'));
    const r = await buildBriefing(input, { ai: a });
    expect(r.aiOk).toBe(true);
    expect(a.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['http failure', null],
    ['dropped project', (t: string) => t.replace('Gamma', 'Something')],
    ['added project name', (t: string) => `${t}\nNewcomer also shipped.`],
    ['banned word', (t: string) => `${t}\nOne is dead.`],
    ['too long', (t: string) => t + ' filler'.repeat(200)],
    ['markdown', (t: string) => `**${t}**`],
    ['new number', (t: string) => `${t}\n99 more`],
  ])('falls back to the template: %s', async (_n, mutate) => {
    const t = await template();
    const a = mutate ? ai(mutate(t)) : ai('', false);
    const r = await buildBriefing(input, { ai: a });
    expect(r).toEqual({ text: t, aiOk: false });
  });

  it('skips the AI when the budget refuses', async () => {
    const a = ai('x');
    a.budget = vi.fn(async () => false);
    const r = await buildBriefing(input, { ai: a });
    expect(r.aiOk).toBe(false);
    expect(a.fetchImpl).not.toHaveBeenCalled();
  });
});

async function setup() {
  const db = await makeTestDb();
  const a = await seedProject(db, 'alpha', { name: 'Alpha' });
  const b = await seedProject(db, 'beta', { name: 'Beta' });
  const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: new Date('2026-11-06T05:00:00Z'), planned: 2 });
  await insertNight(db, { projectId: a.id, night: '2026-11-06', shiftId: shift.id, status: 'shipped', observed: true, summary: 'Shipped a thing.' });
  await insertNight(db, { projectId: b.id, night: '2026-11-06', shiftId: shift.id, status: 'quiet', observed: true });
  // a reconstructed row must not leak into the briefing
  await insertNight(db, { projectId: b.id, night: '2026-11-05', status: 'shipped', observed: false });
  await updateShift(db, shift.id, { finishedAt: new Date('2026-11-06T05:30:00Z'), status: 'attested' });
  return { db, a, b, shift };
}

describe('onShiftFinalized', () => {
  it('sends once per night even when called twice', async () => {
    const { db, a, b, shift } = await setup();
    await db.insert(subscriptions).values({ channel: 'telegram', target: '111', projectIds: [a.id, b.id] });
    const sendTelegram = vi.fn(async () => ({ ok: true as const }));
    const deps = { db, sendTelegram, now: () => new Date('2026-11-06T05:31:00Z'), sleep: async () => {} };
    expect(await onShiftFinalized(shift.id, deps)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(await onShiftFinalized(shift.id, deps)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const text = (sendTelegram.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain('Shipped (1): Alpha');
    expect(text).toContain('Quiet (1): Beta');
    const [row] = await db.select().from(subscriptions);
    expect(row.lastSentAt).not.toBeNull();
  });

  it('resolves addresses, skips unconfigured channels, survives one failing subscription', async () => {
    const { db, a, b, shift } = await setup();
    await db.insert(subscriptions).values([
      { channel: 'telegram', target: '1', addresses: [ADDR] },
      { channel: 'telegram', target: '2', projectIds: [b.id] },
      { channel: 'webpush', target: '{}', projectIds: [a.id] },
      { channel: 'telegram', target: '3', projectIds: [] },
    ]);
    const sendTelegram = vi.fn(async (chat: string) => {
      if (chat === '1') throw new Error('boom');
      return { ok: true as const };
    });
    const resolveAddresses = vi.fn(async () => [a.id]);
    const r = await onShiftFinalized(shift.id, { db, sendTelegram, resolveAddresses, sleep: async () => {} });
    expect(resolveAddresses).toHaveBeenCalledWith([ADDR]);
    expect(r).toEqual({ sent: 1, skipped: 2, failed: 1 });
  });

  it('drops a subscription whose bot was blocked and does nothing without a finished nightly shift', async () => {
    const { db, a, shift } = await setup();
    await db.insert(subscriptions).values({ channel: 'telegram', target: '9', projectIds: [a.id] });
    const sendTelegram = vi.fn(async () => ({ ok: false as const, blocked: true, code: 'http_403' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await onShiftFinalized(shift.id, { db, sendTelegram, sleep: async () => {} });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await onShiftFinalized(9999, { db, sendTelegram })).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it('delivers web push and deletes expired endpoints', async () => {
    const { db, a, shift } = await setup();
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
    await db.insert(subscriptions).values({ channel: 'webpush', target: JSON.stringify(sub), projectIds: [a.id], addresses: [ADDR] });
    const sendWebPush = vi.fn(async () => ({ ok: true as const }));
    await onShiftFinalized(shift.id, { db, sendWebPush, sleep: async () => {} });
    const [endpointSub, payload] = sendWebPush.mock.calls[0] as unknown as [typeof sub, { title: string; url: string; body: string }];
    expect(endpointSub.endpoint).toBe(sub.endpoint);
    expect(payload.title).toBe('Lights On · night 2026-11-06');
    expect(payload.url).toBe(`/b/${ADDR}`);

    await db.update(subscriptions).set({ lastSentAt: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gone = vi.fn(async () => ({ ok: false as const, gone: true, code: 'http_410' }));
    await onShiftFinalized(shift.id, { db, sendWebPush: gone, sleep: async () => {} });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it('includes open challenge windows from tranche_events', async () => {
    const { db, a, shift } = await setup();
    await db.insert(trancheEvents).values({ projectId: a.id, trancheIndex: 2, windowEndsAt: new Date('2026-11-07T12:00:00Z') });
    await db.insert(subscriptions).values({ channel: 'telegram', target: '5', projectIds: [a.id] });
    const sendTelegram = vi.fn(async () => ({ ok: true as const }));
    await onShiftFinalized(shift.id, { db, sendTelegram, now: () => new Date('2026-11-06T05:30:00Z'), sleep: async () => {} });
    expect((sendTelegram.mock.calls[0] as unknown as [string, string])[1]).toContain('Alpha — T2 window closes in 31 h');
  });
});

describe('sendPush', () => {
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
  const cfg = { publicKey: 'pub', privateKey: 'priv', subject: 'https://site/' };
  it('maps 404/410 to gone', async () => {
    const mk = (statusCode: number) => async () => { throw Object.assign(new Error('x'), { statusCode }); };
    expect(await sendPush(sub, pushPayload('a\nb', '2026-11-06'), cfg, mk(410))).toMatchObject({ ok: false, gone: true });
    expect(await sendPush(sub, pushPayload('a\nb', '2026-11-06'), cfg, mk(500))).toMatchObject({ ok: false, gone: false });
    expect(await sendPush(sub, pushPayload('a\nb', '2026-11-06'), cfg, async () => ({}))).toEqual({ ok: true });
  });
  it('body is the first two lines after the title line', () => {
    expect(pushPayload('Lights On · night 2026-11-06\nl1\nl2\nl3', '2026-11-06').body).toBe('l1\nl2');
  });
});

describe('telegram handler', () => {
  it('start subscribes, watch/address mutate the single row, stop deletes', async () => {
    const { db, a } = await setup();
    const sent: string[] = [];
    const ctx = { db, send: async (_c: string, t: string) => { sent.push(t); } };
    const msg = (text: string) => ({ message: { text, chat: { id: 77 } } });

    await handleTelegramUpdate(msg('/start ' + encodeStartToken({ p: 'alpha', a: ADDR })), ctx);
    await handleTelegramUpdate(msg('/watch beta'), ctx);
    await handleTelegramUpdate(msg('/watch nope'), ctx);
    let rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].addresses).toEqual([ADDR]);
    expect(rows[0].projectIds).toHaveLength(2);
    expect(rows[0].projectIds).toContain(a.id);
    expect(sent.join('\n')).toContain('No project called nope');

    await handleTelegramUpdate(msg('/brief'), ctx);
    expect(sent.at(-1)).toContain('Shipped (1): Alpha');

    await handleTelegramUpdate(msg('/start garbage'), ctx);
    expect(sent.at(-1)).toBe(HELP_TEXT);

    await handleTelegramUpdate(msg('/stop'), ctx);
    rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(0);
    await handleTelegramUpdate({ edited_message: {} }, ctx); // ignored
  });
});

describe('telegram route', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
  const req = (secret?: string) => new Request('http://localhost/api/telegram', {
    method: 'POST', body: '{}', headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {},
  });
  it('503 without token, 401 on a wrong secret, 200 on the right one', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = 'whsec';
    expect((await telegramPOST(req('whsec'))).status).toBe(503);
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    expect((await telegramPOST(req())).status).toBe(401);
    expect((await telegramPOST(req('wrong'))).status).toBe(401);
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    expect((await telegramPOST(req('whsec'))).status).toBe(200);
  });
});

describe('push subscribe route', () => {
  const good = { endpoint: 'https://push.example/e1', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
  const call = (method: 'POST' | 'DELETE', body: unknown) =>
    new Request('http://localhost/api/push/subscribe', { method, body: JSON.stringify(body) });
  it('validates, upserts by endpoint, deletes', async () => {
    const db: Db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    await seedProject(db, 'zeta', { name: 'Zeta' });

    expect((await subscribePOST(call('POST', { subscription: { ...good, endpoint: 'http://insecure/x' } }))).status).toBe(400);
    expect((await subscribePOST(call('POST', { subscription: { ...good, keys: { p256dh: 'bad key!', auth: 'a'.repeat(10) } } }))).status).toBe(400);
    expect((await subscribePOST(new Request('http://localhost/x', { method: 'POST', body: 'nope' }))).status).toBe(400);

    expect((await subscribePOST(call('POST', { subscription: good, projects: ['zeta', 'missing'] }))).status).toBe(200);
    expect((await subscribePOST(call('POST', { subscription: good, projects: ['zeta'], addresses: [ADDR] }))).status).toBe(200);
    let rows = await db.select().from(subscriptions).where(eq(subscriptions.channel, 'webpush'));
    expect(rows).toHaveLength(1);
    expect(rows[0].addresses).toEqual([ADDR]);
    expect(rows[0].projectIds).toHaveLength(1);

    expect((await subscribeDELETE(call('DELETE', { endpoint: good.endpoint }))).status).toBe(200);
    rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(0);
  });
});
