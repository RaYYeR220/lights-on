import { formatEther } from "viem";
import type { VibestarterFacts } from "@/lib/types";
import type { LiveCampaign } from "@/lib/views/vibestarterLive";
import { nightLabel } from "@/lib/views/reasons";
import { Countdown } from "./Countdown";
import s from "./project.module.css";

const NAMES = ["Kickstart", "T1", "T2", "T3", "T4", "T5", "T6"];

/** Bar colour from the raw Vibestarter status; the raw word is always printed under it. */
export function trancheKind(status: string): "paid" | "open" | "fail" | "none" {
  const u = status.toUpperCase();
  if (/(PAID|RELEASED|COMPLETE|CLAIMED)/.test(u)) return "paid";
  if (/(REFUND|REJECT|FAIL|CANCEL|CHALLENGED)/.test(u)) return "fail";
  if (/(REQUEST|OPEN|WINDOW|PENDING_RELEASE|ACTIVE)/.test(u)) return "open";
  return "none";
}

interface Row {
  index: number;
  status: string;
  releasePercent: number | null;
  requestedAt: string | null;
  windowEndsAt: string | null;
  amountPaidWei: string | null;
}

const day = (isoTime: string) => {
  const d = new Date(isoTime);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
};
const eth = (wei: string) => {
  const n = Number(formatEther(BigInt(wei)));
  return n >= 1 ? n.toFixed(2) : n.toPrecision(3);
};

export function Tranches({
  vibestarter,
  live,
  facts,
  now,
}: {
  vibestarter: { campaignId: string; escrow: string; founderWallet: string };
  /** The schedule read from Vibestarter just now (preferred). */
  live: LiveCampaign | null;
  /** The schedule as the latest shift recorded it (fallback). */
  facts: { night: number; facts: VibestarterFacts } | null;
  now: number;
}) {
  const rows: Row[] = live
    ? live.tranches
    : (facts?.facts.tranches ?? []).map((t) => ({ ...t, releasePercent: null, amountPaidWei: t.amountPaidWei }));
  const byIndex = new Map(rows.map((t) => [t.index, t]));
  const open = rows.find((t) => t.windowEndsAt !== null && Date.parse(t.windowEndsAt) > now) ?? null;
  const next = rows.find((t) => trancheKind(t.status) === "none");
  return (
    <section className={`panel ${s.card}`} aria-labelledby="tranches-title" data-testid="tranches">
      <div className={s.cardHead}>
        <h2 id="tranches-title" className={s.cardTitle}>
          Vibestarter tranches
        </h2>
        <span className="k">reported · never counted</span>
      </div>
      {open ? (
        <div className={s.banner} role="status" data-testid="challenge-window">
          <i className="sw sw-building" aria-hidden="true" />
          <span>
            {NAMES[open.index] ?? `T${open.index}`} was requested{open.requestedAt ? ` on ${day(open.requestedAt)}` : ""}. Backers can
            challenge it for <Countdown to={open.windowEndsAt!} />.
          </span>
        </div>
      ) : null}
      <ol className={s.tranches}>
        {NAMES.map((name, i) => {
          const t = byIndex.get(i);
          return (
            <li key={name} className={s.tr}>
              <i className={s.trBar} data-k={t ? trancheKind(t.status) : "none"} aria-hidden="true" />
              <span className={s.trName}>
                {name}
                {t?.releasePercent !== null && t?.releasePercent !== undefined ? ` · ${t.releasePercent}%` : ""}
              </span>
              <span>{t ? t.status.toLowerCase().replace(/_/g, " ") : "unknown"}</span>
              {t?.amountPaidWei ? <span>{eth(t.amountPaidWei)} ETH</span> : null}
              {t?.requestedAt && !t.amountPaidWei ? <span>asked {day(t.requestedAt)}</span> : null}
            </li>
          );
        })}
      </ol>
      <p className={s.small} style={{ marginTop: 14 }}>
        {live
          ? `Read from Vibestarter at ${new Date(live.fetchedAt).toISOString().slice(11, 16)} UTC (refreshed every 10 minutes). `
          : facts
            ? `Vibestarter did not answer just now; as recorded on the night of ${nightLabel(facts.night)}. `
            : "Vibestarter did not answer just now and no shift has recorded the schedule yet. "}
        {next && !open
          ? `${NAMES[next.index] ?? `T${next.index}`} is ${next.status.toLowerCase()}: the founder requests it, then backers get a challenge window. `
          : ""}
        Escrow{" "}
        <a className="ul" href={`https://basescan.org/address/${vibestarter.escrow}`} target="_blank" rel="noreferrer">
          {vibestarter.escrow.slice(0, 6)}…{vibestarter.escrow.slice(-4)}
        </a>
      </p>
    </section>
  );
}
