import { loadEnv } from './_backfill';

loadEnv();

/** Run once after deploy: points the bot at <site>/api/telegram with the secret header. */
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
  if (!token || !secret || !site.startsWith('https://')) {
    throw new Error('Need TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an https NEXT_PUBLIC_SITE_URL');
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${site}/api/telegram`, secret_token: secret, allowed_updates: ['message'] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { ok?: boolean; description?: string };
  console.log(res.ok && body.ok ? `webhook set: ${site}/api/telegram` : `setWebhook failed: ${res.status} ${body.description ?? ''}`);
  if (!body.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : 'error'); process.exit(1); });
