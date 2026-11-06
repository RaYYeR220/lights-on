"use client";

import { Fragment, useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { StripNight } from "@/lib/views/project";
import { nightLabel, STATUS_LABEL } from "@/lib/views/reasons";
import { NightDrawer } from "./NightDrawer";
import s from "./project.module.css";

const CODE = { shipped: "s", building: "b", quiet: "q", down: "d", unavailable: "u" } as const;

function paneLabel(n: StripNight): string {
  const day = nightLabel(n.night, true);
  if (!n.status) return `${day}: no reading`;
  return `${day}: ${STATUS_LABEL[n.status].toLowerCase()}${n.observed ? "" : ", reconstructed"}${n.founderNotes.length ? ", founder note" : ""}`;
}

/** The project's last 90 nights as one ribbon window (3 sashes of 30 lites); each lite opens that night. */
export function NightStrip({ slug, strip, watcher }: { slug: string; strip: StripNight[]; watcher: string | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const [focus, setFocus] = useState(strip.length - 1);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const last = strip.length - 1;

  const move = useCallback((i: number) => {
    const j = Math.max(0, Math.min(last, i));
    setFocus(j);
    refs.current[j]?.focus();
  }, [last]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const cols = window.matchMedia("(max-width: 640px)").matches ? 15 : 30;
    const d = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[e.key];
    if (d) {
      e.preventDefault();
      move(i + d);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(last);
    }
  }

  return (
    <>
      <div className={s.window}>
        <div className={s.frame}>
          <div
            className={s.grid}
            role="group"
            aria-label="The last 90 nights, oldest first. Arrow keys move between nights, Enter opens one."
            data-testid="night-strip"
          >
            {strip.map((n, i) => {
              const code = n.status ? CODE[n.status] : "none";
              const cls = [s.pane, s[code], n.status && !n.observed ? s.rec : "", i === last ? s.last : "", n.founderNotes.length ? s.noted : ""].join(" ");
              return (
                <Fragment key={n.night}>
                  {i > 0 && i % 30 === 0 ? <i className={s.row3} aria-hidden="true" /> : null}
                  <button
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    type="button"
                    className={cls}
                    data-night={n.night}
                    aria-label={paneLabel(n)}
                    aria-pressed={open === i}
                    aria-haspopup="dialog"
                    title={paneLabel(n)}
                    tabIndex={i === focus ? 0 : -1}
                    onKeyDown={(e) => onKey(e, i)}
                    onFocus={() => setFocus(i)}
                    onClick={() => setOpen(i)}
                  />
                </Fragment>
              );
            })}
          </div>
          <div className={s.sill} aria-hidden="true" />
        </div>
        <span className={s.tonight} title="Tonight, still to come" aria-hidden="true" />
      </div>
      <div className={s.axis}>
        <span>{nightLabel(strip[0].night)}</span>
        <span>{nightLabel(strip[last].night)} · outlined: tonight</span>
      </div>
      <NightDrawer
        slug={slug}
        night={open === null ? null : strip[open]}
        watcher={watcher}
        onClose={() => {
          const i = open;
          setOpen(null);
          if (i !== null) requestAnimationFrame(() => refs.current[i]?.focus());
        }}
      />
    </>
  );
}
