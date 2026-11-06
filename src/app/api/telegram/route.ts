import { getDb } from '@/lib/db';
import { json, secretEquals } from '@/lib/net/http';
import { safeErrorCode } from '@/lib/net/redact';
import { handleTelegramUpdate, sendMessage } from '@/lib/notify/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Telegram webhook. Authenticated by the secret_token header set with setWebhook. */
export async function POST(req: Request): Promise<Response> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return json({ error: 'not_configured' }, 503);
  if (!secretEquals(req.headers.get('x-telegram-bot-api-secret-token'), secret)) return json({ error: 'unauthorized' }, 401);
  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  try {
    const db = await getDb();
    await handleTelegramUpdate(update, {
      db,
      send: (chat, text) => sendMessage(chat, text, { token }),
    });
  } catch (e) {
    // 200 anyway: Telegram would retry the same update forever.
    console.error('telegram.update failed:', safeErrorCode(e));
  }
  return json({ ok: true });
}
