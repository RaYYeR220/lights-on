import type { TrancheFact, VibestarterFacts } from "@/lib/types";
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

export function Tranches({
  vibestarter,
  facts,
  now,
}: {
  vibestarter: { campaignId: string; escrow: string; founderWallet: string };
  facts: { night: number; facts: VibestarterFacts } | null;
  now: number;
}) {
  const byIndex = new Map<number, TrancheFact>((facts?.facts.tranches ?? []).map((t) => [t.index, t]));
  const open = facts?.facts.openWindow;
  const openLive = open?.windowEndsAt && Date.parse(open.windowEndsAt) > now ? open : null;
  return (
    <section className={`panel ${s.card}`} aria-labelledby="tranches-title" data-testid="tranches">
      <div className={s.cardHead}>
        <h2 id="tranches-title" className={s.cardTitle}>
          Vibestarter tranches
        </h2>
        <span className="k">reported · never counted</span>
      </div>
      {openLive ? (
        <div className={s.banner} role="status">
          <i className="sw sw-building" aria-hidden="true" />
          <span>
            Challenge window for {NAMES[openLive.index] ?? `T${openLive.index}`} is open. Backers can challenge it for{" "}
            <Countdown to={openLive.windowEndsAt!} />.
          </span>
        </div>
      ) : null}
      <ol className={s.tranches}>
        {NAMES.map((name, i) => {
          const t = byIndex.get(i);
          return (
            <li key={name} className={s.tr}>
              <i className={s.trBar} data-k={t ? trancheKind(t.status) : "none"} aria-hidden="true" />
              <span className={s.trName}>{name}</span>
              <span>{t ? t.status.toLowerCase().replace(/_/g, " ") : "unknown"}</span>
            </li>
          );
        })}
      </ol>
      <p className={s.small} style={{ marginTop: 14 }}>
        {facts
          ? `As read on the night of ${nightLabel(facts.night)}. `
          : "No tranche data recorded yet: the nightly shift reads the campaign from Vibestarter, starting with the first live night. "}
        Escrow{" "}
        <a className="ul" href={`https://basescan.org/address/${vibestarter.escrow}`} target="_blank" rel="noreferrer">
          {vibestarter.escrow.slice(0, 6)}…{vibestarter.escrow.slice(-4)}
        </a>
      </p>
    </section>
  );
}
