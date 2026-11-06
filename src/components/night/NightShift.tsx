import Link from "next/link";
import type { NightView } from "@/lib/views/night";
import { nightLabel, STATUS_LABEL } from "@/lib/views/reasons";
import { nightDate } from "@/lib/shift/night";
import type { Status } from "@/lib/types";
import { Countdown } from "@/components/project/Countdown";
import s from "./night.module.css";

const ORDER: Status[] = ["shipped", "building", "quiet", "down", "unavailable"];
const swatch = (st: Status) => (st === "unavailable" ? "sw-none" : `sw-${st}`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** Next scheduled shift (05:00 UTC) after `now`, ISO. */
export function nextShiftIso(now: number): string {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5);
  return new Date(t > now ? t : t + 86_400_000).toISOString();
}

export function NightShift({ view, asked, now }: { view: NightView; asked: number | null; now: number }) {
  const live = view.mode === "observed";
  const day = view.night ? nightLabel(view.night, true) : null;
  const lit = view.rows.filter((r) => r.status === "shipped" || r.status === "building");
  const title = asked ? `The shift of ${nightLabel(asked, true)}` : "Last night's shift";

  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">
        <span>{live && day ? `Night of ${day}` : asked ? `Night of ${nightLabel(asked, true)}` : "No live night yet"}</span>
        <span className={s.nav}>
          {view.prev ? (
            <Link className="ul" href={`/night/${nightDate(view.prev)}`}>
              Earlier: {nightLabel(view.prev)}
            </Link>
          ) : null}
          {view.next ? (
            <Link className="ul" href={`/night/${nightDate(view.next)}`}>
              Later: {nightLabel(view.next)}
            </Link>
          ) : null}
          {asked ? (
            <Link className="ul" href="/night">
              Latest
            </Link>
          ) : null}
        </span>
      </p>
      <h1 className="h-page rv d1">{title}</h1>

      {view.mode !== "observed" ? (
        <div className={`panel ${s.notice} rv d2`} role="status" data-testid="night-notice">
          {asked && view.latestObserved !== null ? (
            <>
              <b>No live shift ran for this night.</b>{" "}
              {view.mode === "preview" ? "Below is its reconstructed history, labelled as such and never attested." : "There is no reading for it either."}
            </>
          ) : (
            <>
              <b>No live shift has run yet.</b> The first live night arrives at 05:00 UTC, in{" "}
              <Countdown to={nextShiftIso(now)} doneText="progress now" />.{" "}
              {view.mode === "preview" && day
                ? `Until then, this is a preview: the latest reconstructed night (${day}), rebuilt from git history and Wayback captures. Reconstructed nights are never attested.`
                : "Nothing has been recorded for it yet."}
            </>
          )}
        </div>
      ) : null}

      {view.rows.length ? (
        <>
          <div className={`${s.counts} rv d2`} aria-label={live ? "Counts by status" : "Counts by status (reconstructed preview)"}>
            {ORDER.map((st) => (
              <div key={st} className={`panel ${s.count}`}>
                <span className={s.countL}>
                  <i className={`sw ${swatch(st)}`} aria-hidden="true" />
                  {STATUS_LABEL[st].toLowerCase()}
                </span>
                <span className={s.countN}>{view.counts[st]}</span>
              </div>
            ))}
          </div>
          <p className={s.att}>
            <span>{view.rows.length} projects{live ? " checked" : " in the preview"}</span>
            {live ? (
              view.attestations.length ? (
                view.attestations.map((a) => (
                  <span key={a.tx} className={s.root} data-testid="night-root">
                    <a className="ul" href={`https://basescan.org/tx/${a.tx}`} target="_blank" rel="noreferrer">
                      {a.count ? `One root attestation for ${a.count} project-night${a.count === 1 ? "" : "s"}` : "Root attestation"} · tx {short(a.tx)}
                    </a>
                    {a.manifest ? (
                      <a className="ul" href={`/api/v1/manifest/${a.manifest}`} target="_blank" rel="noreferrer">
                        View night manifest
                      </a>
                    ) : null}
                  </span>
                ))
              ) : (
                <span>not attested yet</span>
              )
            ) : (
              <span>
                <i className="sw sw-hatch" aria-hidden="true" /> reconstructed: never attested
              </span>
            )}
          </p>
        </>
      ) : null}

      {view.rows.length ? (
        <section className={s.sec} aria-labelledby="shipped-title">
          <div className={s.secHead}>
            <h2 id="shipped-title" className="h-sec">
              What shipped
            </h2>
            <span className="k">shipped and building nights, with the work behind them</span>
          </div>
          {lit.length ? (
            <ul className={s.feed} data-testid="shipped-feed">
              {lit.map((r) => (
                <li key={r.slug} className={`panel ${s.item}`}>
                  <i className={`sw ${swatch(r.status)}`} aria-hidden="true" />
                  <div>
                    <Link className={s.name} href={`/p/${r.slug}`}>
                      {r.name}
                    </Link>
                    <div className={s.sub}>
                      {STATUS_LABEL[r.status]}
                      {r.observed ? "" : " · reconstructed"}
                      {r.attestationUid ? (
                        <>
                          {" · "}
                          <a className="ul" href={`https://base.easscan.org/attestation/view/${r.attestationUid}`} target="_blank" rel="noreferrer">
                            attestation
                          </a>
                        </>
                      ) : null}
                    </div>
                    {r.summary ? (
                      <p className={s.lines} style={{ fontFamily: "var(--body)", fontSize: 14 }}>
                        {r.summary}
                      </p>
                    ) : r.whatShipped.length ? (
                      <ul className={s.lines}>
                        {r.whatShipped.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className={s.sub}>No detail was recorded beyond the status.</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lede" style={{ marginTop: 0 }}>
              Nothing shipped or landed this night.
            </p>
          )}
        </section>
      ) : null}

      {view.rows.length ? (
        <section className={s.sec} aria-labelledby="all-title">
          <div className={s.secHead}>
            <h2 id="all-title" className="h-sec">
              Every project
            </h2>
            <span className="k">{live ? "in the order the shift confirmed them" : "in building order"}</span>
          </div>
          <ul className={s.list}>
            {view.rows.map((r) => (
              <li key={r.slug}>
                <i className={`sw ${swatch(r.status)}`} aria-hidden="true" />
                <Link href={`/p/${r.slug}`}>{r.name}</Link>
                <span className={s.st}>{r.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
