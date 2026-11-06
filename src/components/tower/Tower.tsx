"use client";

import Link from "next/link";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { drawZoom, TowerEngine } from "./engine";
import {
  claimsNothingNew,
  describeWindow,
  isLit,
  statusLine,
  swatchFor,
  whatLabel,
  type TowerModel,
  type TowerWindow,
} from "./model";
import s from "./tower.module.css";

const GROUP_LABEL =
  "The watched building. One window per project, 90 small panes per window, one per night: oldest top left, the latest night bottom right. Arrow keys move between windows, Enter opens one, hold Space to play all 90 nights.";

/** The overlay links: one real focus and click target per bay. Rendered once; the engine positions them. */
const Bays = memo(function Bays({ model }: { model: TowerModel }) {
  const firstProject = model.wins.length ? 0 : -1;
  return (
    <div className={s.bays} role="group" aria-label={GROUP_LABEL} data-tower-bays="">
      {Array.from({ length: model.nwin }, (_, b) => {
        const w = model.wins[b];
        return w ? (
          <Link
            key={w.slug}
            href={`/p/${encodeURIComponent(w.slug)}`}
            prefetch={false}
            className={s.bay}
            data-b={b}
            data-slug={w.slug}
            aria-label={describeWindow(w)}
            tabIndex={b === firstProject ? 0 : -1}
          />
        ) : (
          <Link
            key={`vacant-${b}`}
            href="/add"
            prefetch={false}
            className={s.bay}
            data-b={b}
            aria-label="Vacant bay. Add a project to the watch."
            tabIndex={firstProject < 0 && b === 0 ? 0 : -1}
          />
        );
      })}
    </div>
  );
});

function Card({ w }: { w: TowerWindow }) {
  const zoom = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (zoom.current) drawZoom(zoom.current, w);
  }, [w]);
  const lit = isLit(w.st);
  return (
    <>
      <div className={s.zoom}>
        <canvas ref={zoom} width={10} height={10} />
        <span className={s.cap}>1 pane = 1 night</span>
      </div>
      <div>
        <div className={s.nm}>{w.name}</div>
        <div className={s.src}>{w.src}</div>
        <div className={s.st}>
          <i className={`sw ${swatchFor(w.st)}`} aria-hidden="true" />
          <span>{statusLine(w)}</span>
        </div>
        {lit && w.w.length > 0 ? (
          <>
            <div className={s.wl}>{whatLabel(w)}</div>
            {w.w.map((line) => (
              <div key={line} className={s.wt}>
                {line}
              </div>
            ))}
          </>
        ) : claimsNothingNew(w.st) ? (
          <div className={s.none}>Nothing new reached users.</div>
        ) : null}
        <div className={s.ft}>
          Lit {w.l30} of the last 30 nights{w.streak >= 2 ? ` · ${w.streak} nights running` : ""}
          {w.rn > 0 ? (
            <div className={s.tag}>
              <i className="sw sw-hatch" aria-hidden="true" />
              Reconstructed history
            </div>
          ) : null}
        </div>
        <div className={s.tap}>Tap the window again to open it.</div>
      </div>
    </>
  );
}

export function Tower({ model }: { model: TowerModel }) {
  const facade = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const railL = useRef<HTMLSpanElement>(null);
  const railR = useRef<HTMLSpanElement>(null);
  const tn = useRef<HTMLElement>(null);
  const prog = useRef<HTMLElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const chipT = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const engine = useRef<TowerEngine | null>(null);
  // `shown` keeps the last card's content while it fades out; `on` says whether it is visible
  const [shown, setShown] = useState(-1);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const f = facade.current;
    const bays = f?.querySelector<HTMLElement>("[data-tower-bays]");
    if (!f || !canvas.current || !bays || !rail.current || !railL.current || !railR.current) return;
    if (!tn.current || !prog.current || !chip.current || !chipT.current || !card.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let e: TowerEngine;
    try {
      e = new TowerEngine(
        {
          facade: f,
          canvas: canvas.current,
          bays,
          rail: rail.current,
          railL: railL.current,
          railR: railR.current,
          tn: tn.current,
          prog: prog.current,
          chip: chip.current,
          chipT: chipT.current,
          card: card.current,
        },
        model,
        {
          reduce,
          onActive: (b) => {
            if (b >= 0) setShown(b);
            setOn(b >= 0);
          },
          onLapse: () => {},
        },
      );
    } catch {
      return; // no 2D canvas: the sr-only list and the links still work
    }
    engine.current = e;
    e.start();
    return () => {
      e.destroy();
      engine.current = null;
    };
  }, [model]);

  useLayoutEffect(() => {
    if (on && shown >= 0 && card.current) engine.current?.placeCard(card.current, shown);
  }, [on, shown]);

  const w = shown >= 0 ? model.wins[shown] : undefined;
  const open = model.nwin - model.wins.length;

  return (
    <div className={`${s.facade} fd`} ref={facade}>
      <div className={s.rail} ref={rail}>
        <span>
          <i className={s.tn} ref={tn} data-off="" aria-hidden="true" />
          <span ref={railL}>Last night&apos;s shift</span>
        </span>
        <span>
          <i className={s.hold} aria-hidden="true" />
          <span ref={railR}>Press and hold to play 90 nights</span>
        </span>
        <i className={s.prog} ref={prog} aria-hidden="true" />
      </div>
      <canvas className={s.bldg} ref={canvas} aria-hidden="true" data-testid="tower-canvas" />
      <Bays model={model} />
      <div className={s.chip} ref={chip} aria-hidden="true">
        <i className={s.lead} />
        <i className="sw sw-shipped" />
        <span ref={chipT} />
      </div>
      <div
        className={s.card}
        ref={card}
        aria-hidden="true"
        data-on={on ? "" : undefined}
        data-vacant={shown >= 0 && !w ? "" : undefined}
      >
        {shown < 0 ? null : w ? (
          <Card w={w} />
        ) : (
          <div>
            <div className={s.nm}>Vacant bay</div>
            <div className={s.none}>No project lives here yet. Add one to the watch and it gets this window from tonight.</div>
          </div>
        )}
      </div>
      <div className={s.ground}>
        <span>
          {model.wins.length} projects watched · {open} bays open
        </span>
        <Link href="/add">Add a project to the watch</Link>
      </div>
      <ul className="sr-only" data-testid="tower-list" aria-label="Watched projects, in building order">
        {model.wins.map((x) => (
          <li key={x.slug}>
            <Link href={`/p/${encodeURIComponent(x.slug)}`} prefetch={false} tabIndex={-1}>
              {describeWindow(x)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
