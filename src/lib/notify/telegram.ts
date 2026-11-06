import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getLatestFinishedNightly, getProjectBySlug } from '@/lib/db/queries';
import { nightOf } from '@/lib/shift/night';
import { buildBriefing, gatherBriefingProjects, type BriefingDeps } from './briefing';

export const MAX_ADDRESSES = 10;
export const MAX_PROJECTS = 50;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const HELP_TEXT = [
  'Lights On sends a morning briefing about the projects you follow.',
  '/watch <slug> follow a project',
  '/address <0x…> follow the projects a wallet backs',
  '/brief send the latest briefing now',
  '/stop stop all briefings',
].join('\n');

export type Command =
  | { cmd: 'start'; address?: string; slug?: string }
  | { cmd: 'watch'; slug: string }
  | { cmd: 'address'; address: string }
  | { cmd: 'brief' }
  | { cmd: 'stop' }
  | { cmd: 'help' };

const StartToken = z.object({ a: z.string().regex(ADDRESS).optional(), p: z.string().regex(SLUG).optional() })
  .refine((v) => v.a !== undefined || v.p !== undefined);

/** Deep-link token: base64url of {a?: address, p?: slug}. */
export function decodeStartToken(token: string): { address?: string; slug?: string } | null {
  if (!token || token.length > 400 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const v = StartToken.safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    if (!v.success) return null;
    return { ...(v.data.a ? { address: v.data.a.toLowerCase() } : {}), ...(v.data.p ? { slug: v.data.p } : {}) };
  } catch {
    return null;
  }
}

export function encodeStartToken(v: { a?: string; p?: string }): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

export function parseCommand(text: string): Command {
  const m = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+(.*))?$/s.exec((text ?? '').trim());
  if (!m) return { cmd: 'help' };
  const arg = (m[2] ?? '').trim().split(/\s+/)[0] ?? '';
  switch (m[1].toLowerCase()) {
    case 'start': {
      if (!arg) return { cmd: 'help' };
      const t = decodeStartToken(arg);
      return t ? { cmd: 'start', ...t } : { cmd: 'help' };
    }
    case 'watch': {
      const slug = arg.toLowerCase();
      return SLUG.test(slug) ? { cmd: 'watch', slug } : { cmd: 'help' };
    }
    case 'address': return ADDRESS.test(arg) ? { cmd: 'address', address: arg.toLowerCase() } : { cmd: 'help' };
    case 'brief': return { cmd: 'brief' };
    case 'stop': return { cmd: 'stop' };
    default: return { cmd: 'help' };
  }
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type SendResult = { ok: true } | { ok: false; blocked: boolean; code: string };
export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Bot API call over a fixed endpoint. `plain` text is escaped here. */
export async function sendMessage(
  chatId: string | number, plain: string, cfg: { token: string; fetch?: TelegramFetch },
): Promise<SendResult> {
  const f = cfg.fetch ?? (fetch as unknown as TelegramFetch);
  try {
    const res = await f(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: escapeHtml(plain), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, blocked: res.status === 403, code: `http_${res.status}` };
  } catch (e) {
    const timeout = e instanceof Error && /timeout|abort/i.test(e.name);
    return { ok: false, blocked: false, code: timeout ? 'timeout' : 'error' };
  }
}

export interface TelegramCtx {
  db: Db;
  send: (chatId: string, plain: string) => Promise<unknown>;
  now?: () => Date;
  briefing?: BriefingDeps;
  resolveAddresses?: (addrs: string[]) => Promise<number[]>;
}

const Update = z.object({
  message: z.object({
    text: z.string().optional(),
    chat: z.object({ id: z.union([z.number(), z.string()]) }),
  }).optional(),
});

async function getSub(db: Db, chat: string) {
  const [row] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.channel, 'telegram'), eq(subscriptions.target, chat))).limit(1);
  return row ?? null;
}

const AI_BRIEF_EVERY_MS = 3_600_000;

/** Handle one update; replies via ctx.send. Never throws on bad input. */
export async function handleTelegramUpdate(update: unknown, ctx: TelegramCtx): Promise<void> {
  const u = Update.safeParse(update);
  if (!u.success || !u.data.message) return;
  const chat = String(u.data.message.chat.id);
  const c = parseCommand(u.data.message.text ?? '');
  const { db } = ctx;
  const now = (ctx.now ?? (() => new Date()))();

  /** Adds a project and/or address. Writes (and creates the row) only when something valid results. */
  const follow = async (slug?: string, address?: string): Promise<{ notes: string[]; changed: boolean }> => {
    const notes: string[] = [];
    const sub = await getSub(db, chat);
    let ids = sub?.projectIds ?? [];
    let addrs = sub?.addresses ?? [];
    let changed = false;
    if (slug) {
      const p = await getProjectBySlug(db, slug);
      if (!p || p.hidden) notes.push(`No project called ${slug}.`);
      else if (!ids.includes(p.id) && ids.length >= MAX_PROJECTS) notes.push('You follow the maximum number of projects.');
      else { if (!ids.includes(p.id)) ids = [...ids, p.id]; changed = true; notes.push(`Following ${p.name}.`); }
    }
    if (address) {
      if (!addrs.includes(address) && addrs.length >= MAX_ADDRESSES) notes.push('You follow the maximum number of addresses.');
      else { if (!addrs.includes(address)) addrs = [...addrs, address]; changed = true; notes.push(`Following projects backed by ${address}.`); }
    }
    if (changed) {
      await db.insert(subscriptions)
        .values({ channel: 'telegram', target: chat, projectIds: ids, addresses: addrs })
        .onConflictDoUpdate({ target: [subscriptions.channel, subscriptions.target], set: { projectIds: ids, addresses: addrs } });
    }
    return { notes, changed };
  };
  const reply = async (r: { notes: string[]; changed: boolean }, tail: string) =>
    ctx.send(chat, r.changed ? `${r.notes.join('\n')}\n${tail}` : `${r.notes.join('\n')}\n${HELP_TEXT}`.trim());

  switch (c.cmd) {
    case 'start':
      await reply(await follow(c.slug, c.address), 'You will get a briefing each morning after the nightly shift. /stop ends it.');
      return;
    case 'watch': await reply(await follow(c.slug), 'You get it in the morning briefing.'); return;
    case 'address': await reply(await follow(undefined, c.address), 'You get them in the morning briefing.'); return;
    case 'stop': {
      await db.delete(subscriptions).where(and(eq(subscriptions.channel, 'telegram'), eq(subscriptions.target, chat)));
      await ctx.send(chat, 'Stopped. No more briefings. /watch <slug> starts them again.');
      return;
    }
    case 'brief': {
      const sub = await getSub(db, chat);
      if (!sub) { await ctx.send(chat, 'You follow nothing yet. Try /watch <slug>.'); return; }
      const shift = await getLatestFinishedNightly(db);
      if (!shift) { await ctx.send(chat, 'No nightly shift has finished yet.'); return; }
      const fromAddr = sub.addresses.length && ctx.resolveAddresses ? await ctx.resolveAddresses(sub.addresses) : [];
      const projects = await gatherBriefingProjects(db, [...sub.projectIds, ...fromAddr], shift.night, now);
      if (projects.length === 0) { await ctx.send(chat, 'You follow nothing yet. Try /watch <slug>.'); return; }
      // AI polish: on demand only, at most once per chat per hour (atomic claim); everything else is the template.
      let ai: BriefingDeps['ai'];
      if (ctx.briefing?.ai) {
        const won = await db.update(subscriptions).set({ aiBriefAt: now })
          .where(and(
            eq(subscriptions.id, sub.id),
            or(isNull(subscriptions.aiBriefAt), lt(subscriptions.aiBriefAt, new Date(now.getTime() - AI_BRIEF_EVERY_MS))),
          ))
          .returning({ id: subscriptions.id });
        if (won.length) ai = ctx.briefing.ai;
      }
      const b = await buildBriefing({ projects, date: nightOf(shift.night) }, { ...ctx.briefing, ai });
      await ctx.send(chat, b.text);
      return;
    }
    default:
      await ctx.send(chat, HELP_TEXT);
  }
}
