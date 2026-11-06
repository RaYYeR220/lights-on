import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from '../helpers/db';
import { seedProject } from '../helpers/shift';
import { insertNight, createNightlyShift, updateShift } from '@/lib/db/queries';
import { subscriptions, trancheEvents } from '@/lib/db/schema';
import { hashIp } from '@/lib/shift/limits';
import { getDb, type Db } from '@/lib/db';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { normalizeEndpoint, PushSubscriptionSchema, vapidSubject, isAllowedPushEndpoint, endpointHash, pushHooks, attemptLimiter } from '@/lib/notify/webpush';
import { buildBriefing, templateBriefing, type BriefingProject } from '@/lib/notify/briefing';
import { encodeStartToken, handleTelegramUpdate, parseCommand, HELP_TEXT } from '@/lib/notify/telegram';
import { onShiftFinalized } from '@/lib/notify/send';
import { sendPush, pushPayload } from '@/lib/notify/webpush';
import { POST as telegramPOST } from '@/app/api/telegram/route';
import { POST as subscribePOST, DELETE as subscribeDELETE } from '@/app/api/push/subscribe/route';
import type { NightRow } from '@/lib/db/schema';
import type { Status } from '@/lib/types';

vi.setConfig({ testTimeout: 30_000 });
pushHooks.confirm = async () => ({ ok: true }); // the push service accepts by default

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
    expect(await onShiftFinalized(shift.id, deps)).toEqual({ sent: 0, skipped: 0, failed: 0 });
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
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 1 });
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
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
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
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
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
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/e1', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
  const call = (method: 'POST' | 'DELETE', body: unknown) =>
    new Request('http://localhost/api/push/subscribe', { method, body: JSON.stringify(body) });
  it('validates, upserts by endpoint, deletes', async () => {
    const db: Db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.INTERNAL_RUN_TOKEN = 'salt-token';
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

describe('push endpoint allowlist', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://par02p.notify.windows.com/w/?token=x',
    'https://api.push.apple.com/3/device/x',
    'https://FCM.googleapis.com./fcm/send/x',
  ])('accepts %s', (u) => expect(isAllowedPushEndpoint(u)).toBe(true));

  it.each([
    'https://10.0.0.1/x',
    'https://[::1]/x',
    'https://evil.com/x',
    'https://fcm.googleapis.com.evil.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://evilfcm.googleapis.com/x',
    'https://x.evilnotify.windows.com/x',
    'https://notify.windows.com/x',
    'http://fcm.googleapis.com/x',
    'https://user:pw@fcm.googleapis.com/x',
    'not a url',
  ])('rejects %s', (u) => expect(isAllowedPushEndpoint(u)).toBe(false));

  it('vapid subject: https site url, else mailto', () => {
    expect(vapidSubject('https://lights.example/')).toBe('https://lights.example/');
    expect(vapidSubject('http://localhost:3000')).toBe('mailto:noreply@localhost');
  });
});

describe('push subscribe limits', () => {
  const keys = { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) };
  const mk = (n: number, ip = '203.0.113.9') => new Request('http://localhost/api/push/subscribe', {
    method: 'POST', headers: { 'x-real-ip': ip },
    body: JSON.stringify({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/n${n}`, keys }, addresses: [ADDR] }),
  });
  it('rejects bad hosts with 400; the 6th new subscription from one IP in an hour gets 429', async () => {
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.INTERNAL_RUN_TOKEN = 'salt-token';
    await db.delete(subscriptions);
    for (const bad of ['https://10.0.0.1/x', 'https://evil.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x']) {
      const r = await subscribePOST(new Request('http://localhost/x', {
        method: 'POST', body: JSON.stringify({ subscription: { endpoint: bad, keys }, addresses: [ADDR] }),
      }));
      expect(r.status).toBe(400);
    }
    for (let i = 1; i <= 5; i++) expect((await subscribePOST(mk(i))).status).toBe(200);
    expect((await subscribePOST(mk(1))).status).toBe(200); // re-subscribing an existing endpoint is an update
    expect((await subscribePOST(mk(6))).status).toBe(429);
    expect((await subscribePOST(mk(6, '198.51.100.7'))).status).toBe(200); // another IP is unaffected
    const none = new Request('http://localhost/x', {
      method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/a', keys } }),
    });
    expect((await subscribePOST(none)).status).toBe(400); // nothing to follow
    const rows = await db.select().from(subscriptions);
    expect(rows.every((r) => r.endpointHash && r.endpointHash.length === 64)).toBe(true);
  });
});

describe('atomic sends and paging', () => {
  it('two concurrent calls send once per subscription', async () => {
    const { db, a, shift } = await setup();
    await db.insert(subscriptions).values(Array.from({ length: 30 }, (_, i) => ({ channel: 'telegram' as const, target: `c${i}`, projectIds: [a.id] })));
    const sent: string[] = [];
    const sendTelegram = vi.fn(async (chat: string) => { sent.push(chat); return { ok: true as const }; });
    const deps = { db, sendTelegram, sleep: async () => {} };
    const [r1, r2] = await Promise.all([onShiftFinalized(shift.id, deps), onShiftFinalized(shift.id, deps)]);
    expect(r1.sent + r2.sent).toBe(30);
    expect(new Set(sent).size).toBe(30);
    expect(sent).toHaveLength(30);
  });

  it('250 subscriptions across two budget-limited calls each get exactly one send', async () => {
    const { db, a, shift } = await setup();
    await db.insert(subscriptions).values(Array.from({ length: 250 }, (_, i) => ({ channel: 'telegram' as const, target: `d${i}`, projectIds: [a.id] })));
    const sent: string[] = [];
    const sendTelegram = vi.fn(async (chat: string) => { sent.push(chat); return { ok: true as const }; });
    let t = 0;
    const mkDeps = (budgetMs: number) => ({ db, sendTelegram, clock: () => t, sleep: async (ms: number) => { t += ms; }, budgetMs });
    const r1 = await onShiftFinalized(shift.id, mkDeps(6250));
    expect(r1.sent).toBeGreaterThan(100);
    expect(r1.sent).toBeLessThan(250);
    t = 0;
    const r2 = await onShiftFinalized(shift.id, mkDeps(60_000));
    expect(r1.sent + r2.sent).toBe(250);
    expect(new Set(sent).size).toBe(250);
    expect(sent).toHaveLength(250);
  });

  it('a failed send gives the claim back so a later call retries', async () => {
    const { db, a, shift } = await setup();
    await db.insert(subscriptions).values({ channel: 'telegram', target: 'f1', projectIds: [a.id] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(async () => ({ ok: false as const, blocked: false, code: 'http_500' }));
    expect((await onShiftFinalized(shift.id, { db, sendTelegram: bad, sleep: async () => {} })).failed).toBe(1);
    expect((await db.select().from(subscriptions))[0].lastSentAt).toBeNull();
    const good = vi.fn(async () => ({ ok: true as const }));
    expect((await onShiftFinalized(shift.id, { db, sendTelegram: good, sleep: async () => {} })).sent).toBe(1);
  });
});

describe('telegram: subscriptions only when valid, AI once per hour', () => {
  it('/watch nope creates nothing; the unique index keeps one row per chat', async () => {
    const { db } = await setup();
    const sent: string[] = [];
    const ctx = { db, send: async (_c: string, t: string) => { sent.push(t); } };
    await handleTelegramUpdate({ message: { text: '/watch nope', chat: { id: 5 } } }, ctx);
    await handleTelegramUpdate({ message: { text: '/address 0x12', chat: { id: 5 } } }, ctx);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(sent[0]).toContain(HELP_TEXT);
    await db.insert(subscriptions).values({ channel: 'telegram', target: '5' });
    await expect(db.insert(subscriptions).values({ channel: 'telegram', target: '5' })).rejects.toThrow();
  });

  it('/brief uses the AI at most once per chat per hour', async () => {
    const { db, a } = await setup();
    await db.insert(subscriptions).values({ channel: 'telegram', target: '8', projectIds: [a.id] });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }));
    const briefing = { ai: { budget: async () => true, fetchImpl, apiKey: 'k' } };
    const ctx = { db, send: async () => {}, briefing, now: () => new Date('2026-11-06T08:00:00Z') };
    const msg = { message: { text: '/brief', chat: { id: 8 } } };
    await handleTelegramUpdate(msg, ctx);
    await handleTelegramUpdate(msg, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await handleTelegramUpdate(msg, { ...ctx, now: () => new Date('2026-11-06T09:01:00Z') });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('copy rule on the template', () => {
  it('a banned word in a project name is blanked in the template', () => {
    const t = templateBriefing({ projects: [proj('Rug Pull Tracker', 'shipped', 'ok')], date: 20261106 }, Date.now());
    expect(t).not.toMatch(/\brug\b/i);
  });
});

describe('verified, normalised push subscriptions', () => {
  const keys = { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) };
  const req = (endpoint: string, method: 'POST' | 'DELETE' = 'POST') => new Request('http://localhost/api/push/subscribe', {
    method, headers: { 'x-real-ip': '192.0.2.44' },
    body: JSON.stringify(method === 'POST' ? { subscription: { endpoint, keys }, addresses: [ADDR] } : { endpoint }),
  });
  const fresh = async () => {
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.INTERNAL_RUN_TOKEN = 'salt-token';
    await db.delete(subscriptions);
    attemptLimiter.reset();
    return db;
  };

  it('normalises only a trailing dot and case, never another last character', () => {
    expect(normalizeEndpoint('https://fcm.googleapis.com/x')).toBe('https://fcm.googleapis.com/x');
    expect(normalizeEndpoint('https://fcm.googleapis.com./x')).toBe('https://fcm.googleapis.com/x');
    expect(normalizeEndpoint('https://FCM.GoogleAPIs.com/x')).toBe('https://fcm.googleapis.com/x');
    expect(normalizeEndpoint('https://web.push.apple.com/x')).toBe('https://web.push.apple.com/x');
    expect(normalizeEndpoint('https://fcm.googleapis.com:443/x')).toBe('https://fcm.googleapis.com/x');
    expect(normalizeEndpoint('nope')).toBeNull();
    const parsed = PushSubscriptionSchema.parse({ endpoint: 'https://FCM.googleapis.com./x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
    expect(parsed.endpoint).toBe('https://fcm.googleapis.com/x');
  });

  it('hashes the normalised endpoint', () => {
    expect(endpointHash('https://FCM.googleapis.com./x')).toBe(endpointHash('https://fcm.googleapis.com/x'));
    expect(endpointHash('https://fcm.googleapis.com:443/x')).toBe(endpointHash('https://fcm.googleapis.com/x'));
  });

  it('keeps the row on 201, writes nothing on 410 or other failures', async () => {
    const db = await fresh();
    const saved = pushHooks.confirm;
    try {
      pushHooks.confirm = async () => ({ ok: true });
      expect((await subscribePOST(req('https://FCM.googleapis.com./fcm/send/ok1'))).status).toBe(200);
      expect(await db.select().from(subscriptions)).toHaveLength(1);
      expect((await db.select().from(subscriptions))[0].target).toContain('https://fcm.googleapis.com/fcm/send/ok1');
      pushHooks.confirm = async () => ({ ok: false, gone: true, code: 'http_410' });
      const r = await subscribePOST(req('https://fcm.googleapis.com/fcm/send/dead'));
      expect(r.status).toBe(400);
      expect(JSON.parse(await r.text())).toEqual({ error: 'endpoint_rejected' });
      pushHooks.confirm = async () => ({ ok: false, gone: false, code: 'error' });
      expect((await subscribePOST(req('https://fcm.googleapis.com/fcm/send/err'))).status).toBe(400);
      expect(await db.select().from(subscriptions)).toHaveLength(1);
      pushHooks.confirm = () => null;
      expect((await subscribePOST(req('https://fcm.googleapis.com/fcm/send/nocfg'))).status).toBe(503);
    } finally {
      pushHooks.confirm = saved;
    }
  });

  it('unsubscribing through a differently written endpoint, and a row with a null hash, both delete', async () => {
    const db = await fresh();
    await subscribePOST(req('https://fcm.googleapis.com/fcm/send/del1'));
    expect((await subscribeDELETE(req('https://FCM.googleapis.com./fcm/send/del1', 'DELETE'))).status).toBe(200);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    await db.insert(subscriptions).values({
      channel: 'webpush', target: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/old', keys }), addresses: [ADDR],
    });
    await subscribeDELETE(req('https://fcm.googleapis.com/fcm/send/old', 'DELETE'));
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });
});

describe('reserve before confirm, count attempts', () => {
  const keys = { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) };
  const IP = '198.18.0.5';
  const req = (n: number) => new Request('http://localhost/api/push/subscribe', {
    method: 'POST', headers: { 'x-real-ip': IP },
    body: JSON.stringify({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/r${n}`, keys }, addresses: [ADDR] }),
  });
  const fresh = async () => {
    const db = await getDb('pglite://memory');
    await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.INTERNAL_RUN_TOKEN = 'salt-token';
    await db.delete(subscriptions);
    attemptLimiter.reset();
    return db;
  };

  it('two concurrent subscribes at the limit edge: only one passes', async () => {
    const db = await fresh();
    const ipHash = hashIp(IP, 'push-subscribe', 'salt-token');
    await db.insert(subscriptions).values(Array.from({ length: 4 }, (_, i) => ({
      channel: 'webpush' as const, target: `{"i":${i}}`, endpointHash: `h${i}`, ipHash, addresses: [ADDR],
    })));
    const saved = pushHooks.confirm;
    pushHooks.confirm = async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: true }; };
    try {
      const rs = await Promise.all([subscribePOST(req(1)), subscribePOST(req(2))]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 429]);
      expect(await db.select().from(subscriptions)).toHaveLength(5);
      expect((await db.select().from(subscriptions)).some((r) => r.pending)).toBe(false);
    } finally { pushHooks.confirm = saved; }
  });

  it('a failed confirmation leaves no row; the 11th attempt in an hour gets 429 without sending', async () => {
    const db = await fresh();
    const confirm = vi.fn(async () => ({ ok: false as const, gone: true, code: 'http_410' }));
    const saved = pushHooks.confirm;
    pushHooks.confirm = confirm;
    try {
      for (let i = 1; i <= 10; i++) expect((await subscribePOST(req(i))).status).toBe(400);
      expect(await db.select().from(subscriptions)).toHaveLength(0);
      expect((await subscribePOST(req(11))).status).toBe(429);
      expect(confirm).toHaveBeenCalledTimes(10);
    } finally { pushHooks.confirm = saved; }
  });

  it('the global per-instance cap also returns 429', () => {
    attemptLimiter.reset();
    for (let i = 0; i < 300; i++) expect(attemptLimiter.take(`ip${i}`)).toBe(true);
    expect(attemptLimiter.take('another')).toBe(false);
    attemptLimiter.reset();
  });

  it('the sender skips pending rows', async () => {
    const { db, a, shift } = await setup();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/p1', keys };
    await db.insert(subscriptions).values({ channel: 'webpush', target: JSON.stringify(sub), projectIds: [a.id], pending: true });
    const sendWebPush = vi.fn(async () => ({ ok: true as const }));
    expect(await onShiftFinalized(shift.id, { db, sendWebPush, sleep: async () => {} })).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sendWebPush).not.toHaveBeenCalled();
    await db.update(subscriptions).set({ pending: false });
    expect((await onShiftFinalized(shift.id, { db, sendWebPush, sleep: async () => {} })).sent).toBe(1);
  });
});
