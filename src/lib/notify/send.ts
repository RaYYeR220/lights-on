import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { subscriptions } from '@/lib/db/schema';
import { getShift } from '@/lib/db/queries';
import { safeErrorCode } from '@/lib/net/redact';
import { nightOf } from '@/lib/shift/night';
import type { ShiftDeps } from '@/lib/shift/deps';
import { buildBriefing, gatherBriefingProjects, type BriefingAi, type BriefingProject } from './briefing';
import { sendMessage } from './telegram';
import { parsePushTarget, pushPayload, sendPush, vapidFromEnv, type PushPayload, type PushSub, type PushResult } from './webpush';

export const MAX_SUBS_PER_CALL = 200;
const SPACING_MS = 50; // 20 sends per second

export interface NotifyDeps {
  db: Db;
  now?: () => Date;
  /** Null/absent = channel not configured: its subscriptions are skipped without error. */
  sendTelegram?: ((chatId: string, text: string) => Promise<{ ok: true } | { ok: false; blocked: boolean; code: string }>) | null;
  sendWebPush?: ((sub: PushSub, payload: PushPayload) => Promise<PushResult>) | null;
  /** Task 13 plugs the real backer lookup in here. */
  resolveAddresses?: (addrs: string[]) => Promise<number[]>;
  ai?: BriefingAi;
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

/** Briefing for every subscriber of a finished nightly shift. Idempotent: `last_sent_at >= shift.finished_at` is skipped. */
export async function onShiftFinalized(shiftId: number, deps: NotifyDeps): Promise<NotifyResult> {
  const { db } = deps;
  const out: NotifyResult = { sent: 0, skipped: 0, failed: 0 };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shift = await getShift(db, shiftId);
  if (!shift || shift.kind !== 'nightly' || !shift.finishedAt) return out;
  const date = nightOf(shift.night);

  const subs = await db.select().from(subscriptions).orderBy(asc(subscriptions.id)).limit(MAX_SUBS_PER_CALL);
  const cache = new Map<string, string>();
  let first = true;

  for (const sub of subs) {
    try {
      if (sub.lastSentAt && sub.lastSentAt.getTime() >= shift.finishedAt.getTime()) { out.skipped++; continue; }
      const send = sub.channel === 'telegram' ? deps.sendTelegram : deps.sendWebPush;
      if (!send) { out.skipped++; continue; }

      const fromAddr = sub.addresses.length && deps.resolveAddresses ? await deps.resolveAddresses(sub.addresses) : [];
      const ids = [...new Set([...sub.projectIds, ...fromAddr])].sort((a, b) => a - b);
      if (ids.length === 0) { out.skipped++; continue; }

      const key = ids.join(',');
      let text = cache.get(key);
      if (text === undefined) {
        const projects: BriefingProject[] = await gatherBriefingProjects(db, ids, shift.night, now());
        if (projects.length === 0) { out.skipped++; continue; }
        text = (await buildBriefing({ projects, date }, { ai: deps.ai })).text;
        cache.set(key, text);
      }

      if (!first) await sleep(SPACING_MS);
      first = false;

      if (sub.channel === 'telegram') {
        const r = await deps.sendTelegram!(sub.target, text);
        if (!r.ok) {
          if (r.blocked) await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));
          console.error('notify.telegram failed:', r.code);
          out.failed++;
          continue;
        }
      } else {
        const ps = parsePushTarget(sub.target);
        if (!ps) { await db.delete(subscriptions).where(eq(subscriptions.id, sub.id)); out.failed++; continue; }
        const r = await deps.sendWebPush!(ps, pushPayload(text, shift.night, sub.addresses[0]));
        if (!r.ok) {
          if (r.gone) await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));
          console.error('notify.webpush failed:', r.code);
          out.failed++;
          continue;
        }
      }
      await db.update(subscriptions).set({ lastSentAt: now() })
        .where(eq(subscriptions.id, sub.id));
      out.sent++;
    } catch (e) {
      console.error('notify.subscription failed:', safeErrorCode(e));
      out.failed++;
    }
  }
  return out;
}

/** Shift deps with the briefing hook attached (dispatch, run, finalize-stale and live routes). */
export function withNotify(deps: ShiftDeps): ShiftDeps {
  return {
    ...deps,
    onFinalized: async (shiftId) => {
      await onShiftFinalized(shiftId, {
        db: deps.db,
        now: deps.now,
        ...senderDeps(),
        ai: process.env.VENICE_API_KEY ? { budget: (n) => deps.budget('llm_tokens', n) } : undefined,
      });
    },
  };
}
