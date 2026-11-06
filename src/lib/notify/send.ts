import { and, asc, eq, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getShift } from '@/lib/db/queries';
import { safeErrorCode } from '@/lib/net/redact';
import { nightOf, shiftStartOfNight } from '@/lib/shift/night';
import type { ShiftDeps } from '@/lib/shift/deps';
import { buildBriefing, gatherBriefingProjects, type BriefingProject } from './briefing';
import { sendMessage } from './telegram';
import { parsePushTarget, pushPayload, sendPush, vapidFromEnv, type PushPayload, type PushSub, type PushResult } from './webpush';

export const PAGE_SIZE = 100;
export const TIME_BUDGET_MS = 240_000;
const SPACING_MS = 50; // 20 sends per second

export interface NotifyDeps {
  db: Db;
  now?: () => Date;
  /** Monotonic ms clock for the time budget (tests). */
  clock?: () => number;
  budgetMs?: number;
  /** Null/absent = channel not configured: its subscriptions are skipped without error. */
  sendTelegram?: ((chatId: string, text: string) => Promise<{ ok: true } | { ok: false; blocked: boolean; code: string }>) | null;
  sendWebPush?: ((sub: PushSub, payload: PushPayload) => Promise<PushResult>) | null;
  /** Task 13 plugs the real backer lookup in here. */
  resolveAddresses?: (addrs: string[]) => Promise<number[]>;
  sleep?: (ms: number) => Promise<void>;
}

export interface NotifyResult { sent: number; skipped: number; failed: number }

/** Real senders from env; a channel without its secrets is null. */
export function senderDeps(): Pick<NotifyDeps, 'sendTelegram' | 'sendWebPush'> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const vapid = vapidFromEnv();
  return {
    sendTelegram: token ? (chat, text) => sendMessage(chat, text, { token }) : null,
    sendWebPush: vapid ? (sub, payload) => sendPush(sub, payload, vapid) : null,
  };
}

/**
 * Template briefing for every subscriber of a finished nightly shift (the AI polish is never used here).
 * A subscription is pending while `last_sent_at` is before the night's shift start. Each send is claimed first with an
 * atomic UPDATE, so concurrent or repeated calls send once; a call works through pending rows in pages of 100 until
 * the time budget is spent, and a later call simply continues with what is still pending.
 */
export async function onShiftFinalized(shiftId: number, deps: NotifyDeps): Promise<NotifyResult> {
  const { db } = deps;
  const out: NotifyResult = { sent: 0, skipped: 0, failed: 0 };
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shift = await getShift(db, shiftId);
  if (!shift || shift.kind !== 'nightly' || !shift.finishedAt) return out;
  const date = nightOf(shift.night);
  // Not finishedAt: a re-finalize rewrites that, and rows already served must stay served.
  const threshold = shiftStartOfNight(shift.night);
  const started = clock();
  const budgetMs = deps.budgetMs ?? TIME_BUDGET_MS;
  const cache = new Map<string, string>();
  const seen: number[] = [];
  let first = true;

  const channels = [deps.sendTelegram ? 'telegram' : null, deps.sendWebPush ? 'webpush' : null].filter((c): c is 'telegram' | 'webpush' => !!c);
  if (channels.length === 0) return out;

  for (;;) {
    const page = await db.select().from(subscriptions)
      .where(and(
        or(isNull(subscriptions.lastSentAt), lt(subscriptions.lastSentAt, threshold)),
        or(...channels.map((c) => eq(subscriptions.channel, c))),
        seen.length ? notInArray(subscriptions.id, seen) : undefined,
      ))
      .orderBy(sql`${subscriptions.lastSentAt} asc nulls first`, asc(subscriptions.id))
      .limit(PAGE_SIZE);
    if (page.length === 0) break;

    for (const sub of page) {
      if (clock() - started >= budgetMs) return out;
      seen.push(sub.id);
      let claimedAt: Date | null = null;
      try {
        const fromAddr = sub.addresses.length && deps.resolveAddresses ? await deps.resolveAddresses(sub.addresses) : [];
        const ids = [...new Set([...sub.projectIds, ...fromAddr])].sort((a, b) => a - b);
        if (ids.length === 0) { out.skipped++; continue; }

        const key = ids.join(',');
        let text = cache.get(key);
        if (text === undefined) {
          const projects: BriefingProject[] = await gatherBriefingProjects(db, ids, shift.night, now());
          if (projects.length === 0) { out.skipped++; continue; }
          text = (await buildBriefing({ projects, date })).text;
          cache.set(key, text);
        }

        // Atomic claim: only one caller gets the row back.
        claimedAt = now();
        const won = await db.update(subscriptions).set({ lastSentAt: claimedAt })
          .where(and(eq(subscriptions.id, sub.id), or(isNull(subscriptions.lastSentAt), lt(subscriptions.lastSentAt, threshold))))
          .returning({ id: subscriptions.id });
        if (won.length === 0) { claimedAt = null; out.skipped++; continue; }

        if (!first) await sleep(SPACING_MS);
        first = false;

        let ok = false;
        if (sub.channel === 'telegram') {
          const r = await deps.sendTelegram!(sub.target, text);
          ok = r.ok;
          if (!r.ok) {
            if (r.blocked) { await db.delete(subscriptions).where(eq(subscriptions.id, sub.id)); claimedAt = null; }
            console.error('notify.telegram failed:', r.code);
          }
        } else {
          const ps = parsePushTarget(sub.target);
          if (!ps) {
            await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));
            claimedAt = null;
          } else {
            const r = await deps.sendWebPush!(ps, pushPayload(text, shift.night, sub.addresses[0]));
            ok = r.ok;
            if (!r.ok) {
              if (r.gone) { await db.delete(subscriptions).where(eq(subscriptions.id, sub.id)); claimedAt = null; }
              console.error('notify.webpush failed:', r.code);
            }
          }
        }
        if (ok) { out.sent++; claimedAt = null; } else { out.failed++; }
      } catch (e) {
        console.error('notify.subscription failed:', safeErrorCode(e));
        out.failed++;
      } finally {
        // Not delivered: give the claim back (guarded on the value we set) so a later call retries.
        if (claimedAt) {
          await db.update(subscriptions).set({ lastSentAt: sub.lastSentAt })
            .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.lastSentAt, claimedAt))).catch(() => undefined);
        }
      }
    }
  }
  return out;
}

/** Shift deps with the briefing hook attached (dispatch, run, finalize-stale and live routes). */
export function withNotify(deps: ShiftDeps): ShiftDeps {
  return {
    ...deps,
    onFinalized: async (shiftId) => {
      await onShiftFinalized(shiftId, { db: deps.db, now: deps.now, ...senderDeps() });
    },
  };
}
