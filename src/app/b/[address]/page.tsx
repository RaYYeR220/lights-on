import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { checkBriefingLimit } from "@/lib/briefingLimit";
import { safeErrorCode } from "@/lib/net/redact";
import { getBackerView, resolveBacker, shortAddress, telegramStartToken, type BackerView } from "@/lib/views/backer";
import { nightLabel, STATUS_LABEL } from "@/lib/views/reasons";
import { BagsForm } from "@/components/bags/BagsForm";
import { PushSubscribe } from "@/components/bags/PushSubscribe";
import s from "@/components/bags/backer.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/b/[address]">): Promise<Metadata> {
  const seg = (await params).address;
  let raw = seg;
  try {
    raw = decodeURIComponent(seg);
  } catch {
    /* keep the raw segment */
  }
  return { title: `Bags of ${shortAddress(raw)} · Lights On`, robots: { index: false } };
}

const ERRORS: Record<string, string> = {
  invalid_address: "That is not a wallet address or an ENS name. Use a 0x address or a name like vitalik.eth.",
  ens_unavailable: "ENS names cannot be looked up on this deployment right now. Paste the 0x address instead.",
  ens_not_found: "That ENS name does not point to an address.",
};

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">Backers</p>
      <h1 className="h-page rv d1">{title}</h1>
      <p className="lede rv d1">{text}</p>
      <div className="rv d2" style={{ marginTop: 32 }}>
        <BagsForm size="page" />
      </div>
    </main>
  );
}

const swatch = (st: string | null) => (st === "shipped" || st === "building" || st === "quiet" || st === "down" ? `sw-${st}` : "sw-none");

/** "70,777,741.78" for display; a raw integer (decimals unknown) is labelled as such. */
function formatBalance(v: string, raw: boolean): string {
  if (raw) return `${v} (raw units, decimals unknown)`;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function viaText(p: BackerView["projects"][number]): string {
  const parts: string[] = [];
  if (p.via === "vibestarter" || p.contributedEth) {
    parts.push(p.contributedEth ? `backed with ${p.contributedEth} ETH on Vibestarter` : "backed on Vibestarter");
    if (p.refundClaimed) parts.push("refund claimed");
  }
  if (p.balance) parts.push(`holds ${formatBalance(p.balance, p.balanceIsRaw)}${p.symbol ? ` ${p.symbol}` : ""}`);
  if (!parts.length) parts.push("followed");
  return parts.join(" · ");
}

export default async function BackerPage({ params }: PageProps<"/b/[address]">) {
  let raw: string;
  try {
    raw = decodeURIComponent((await params).address).trim();
  } catch {
    return <Problem title="Check your bags" text={ERRORS.invalid_address} />;
  }
  const wait = checkBriefingLimit(await headers());
  if (wait !== null) return <Problem title="Too many lookups" text={`Too many wallet lookups from this network. Try again in ${Math.ceil(wait / 60)} min.`} />;

  const r = await resolveBacker(raw);
  if ("error" in r) return <Problem title="Check your bags" text={ERRORS[r.error]} />;

  let view: BackerView;
  try {
    view = await getBackerView(await getDb(), r.address);
  } catch (e) {
    console.error("backer page failed:", safeErrorCode(e));
    return <Problem title={`Bags of ${shortAddress(r.address)}`} text="The lookup failed just now. Try again in a minute." />;
  }

  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT?.replace(/^@/, "");
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const n = view.projects.length;
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">
        <span>Backer</span>
        <a className="ul" href={`https://basescan.org/address/${view.address}`} target="_blank" rel="noreferrer">
          {view.address}
        </a>
      </p>
      <h1 className="h-page rv d1">Bags of {shortAddress(view.address.toLowerCase())}</h1>
      <p className="lede rv d1">
        {n
          ? `${n} watched project${n === 1 ? "" : "s"} for this wallet: Vibestarter campaigns it backed and watched tokens it holds.`
          : "No watched project found for this wallet: it has not backed a Vibestarter campaign on the watch list and holds none of the watched tokens."}
      </p>
      {view.degraded ? (
        <p className={`panel ${s.notice}`} role="status">
          Some sources did not answer during this lookup (Vibestarter or Base RPC), so the list may be incomplete. Reload to try again.
        </p>
      ) : null}

      <div className={s.grid}>
        <section aria-labelledby="bags-title">
          <h2 id="bags-title" className="sr-only">
            Projects
          </h2>
          {n ? (
            <ul className={s.list} data-testid="backer-projects">
              {view.projects.map((p) => (
                <li key={p.slug} className={`panel ${s.item}`}>
                  <i className={`sw ${swatch(p.status)}`} aria-hidden="true" />
                  <div>
                    <Link className={s.name} href={`/p/${p.slug}`}>
                      {p.name}
                    </Link>
                    <div className={s.via}>{viaText(p)}</div>
                    <div className={s.st}>
                      {p.status && p.statusNight
                        ? `${STATUS_LABEL[p.status]} on ${nightLabel(p.statusNight)}${p.statusObserved ? "" : " · reconstructed"}`
                        : "Not checked yet: its first live night is at 05:00 UTC"}
                    </div>
                  </div>
                  <span className={s.lit}>lit {p.lit30}/30</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lede" style={{ marginTop: 0 }}>
              <Link className="ul" href="/">
                See every watched project
              </Link>
            </p>
          )}
        </section>

        {n ? (
          <section className={`panel ${s.card}`} aria-labelledby="brief-title">
            <h2 id="brief-title" className={s.cardTitle}>
              This morning&apos;s briefing
            </h2>
            <p className={s.small}>
              {view.briefingNight
                ? `From the live shift of ${nightLabel(view.briefingNight, true)}. Telegram and push send the same text.`
                : "No live shift has run yet, so the briefing has no readings in it. The first one goes out after 05:00 UTC."}
            </p>
            <pre className={s.brief} data-testid="briefing">
              {view.briefing}
            </pre>
            <div className={s.sub}>
              {bot ? (
                <div>
                  <a className="btn btn-primary btn-sm" href={`https://t.me/${bot}?start=${telegramStartToken(view.address)}`} target="_blank" rel="noreferrer">
                    Get it on Telegram
                  </a>
                  <p className={s.small}>
                    Or send <code>/address {view.address}</code> to @{bot}.
                  </p>
                </div>
              ) : null}
              {vapid ? <PushSubscribe address={view.address} vapidKey={vapid} /> : null}
              {!bot && !vapid ? <p className={s.small}>Subscriptions open on the deployed site.</p> : null}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
