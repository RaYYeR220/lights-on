"use client";

import { useEffect, useRef, useState } from "react";
import type { Status, Step } from "@/lib/types";
import { STATUS_LABEL, STATUS_MEANING } from "@/lib/views/reasons";
import { sseEvents } from "./sse";
import s from "./project.module.css";

interface Done {
  status: Status | null;
  evidenceHash: string | null;
  attestationUid: string | null;
  txHash: string | null;
  attestSkipped: string | null;
  error?: string;
}

type Phase =
  | { k: "idle" }
  | { k: "running" }
  | { k: "done"; done: Done }
  | { k: "error"; message: string };

const SKIPPED: Record<string, string> = {
  gas_cap: "the daily gas cap is reached",
  disabled: "attesting is switched off on this deployment",
  error: "the transaction did not go through",
};

function waitText(sec: number): string {
  if (sec < 90) return `${sec} s`;
  return `${Math.ceil(sec / 60)} min`;
}

/** "Run a shift now": a live check of this one project, streamed step by step, ending in its attestation. */
export function LiveShift({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [steps, setSteps] = useState<Step[]>([]);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);

  async function run() {
    ac.current?.abort();
    const ctl = new AbortController();
    ac.current = ctl;
    setSteps([]);
    setPhase({ k: "running" });
    let res: Response;
    try {
      res = await fetch(`/api/shift/live?project=${encodeURIComponent(slug)}`, {
        headers: { accept: "text/event-stream" },
        signal: ctl.signal,
        cache: "no-store",
      });
    } catch {
      if (!ctl.signal.aborted) setPhase({ k: "error", message: "The live shift could not be reached. Check your connection and try again." });
      return;
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retryAfterSec?: number; reason?: string };
      const sec = Number(res.headers.get("retry-after")) || body.retryAfterSec || 60;
      setPhase({ k: "error", message: `Live shifts are rate limited${body.reason ? ` (${body.reason.replace(/_/g, " ")})` : ""}. Try again in ${waitText(sec)}.` });
      return;
    }
    if (res.status === 403) {
      setPhase({ k: "error", message: "Live shifts can only be started from this site." });
      return;
    }
    if (res.status === 503) {
      setPhase({ k: "error", message: "Live shifts are not available on this deployment right now. The nightly shift still runs at 05:00 UTC." });
      return;
    }
    if (!res.ok || !res.body) {
      setPhase({ k: "error", message: res.status === 404 ? "This project is not on the watch list." : `The live shift did not start (HTTP ${res.status}).` });
      return;
    }
    try {
      for await (const ev of sseEvents(res.body)) {
        if (ev.event === "step") {
          const st = JSON.parse(ev.data) as Step;
          setSteps((cur) => {
            const i = cur.findIndex((x) => x.key === st.key);
            if (i < 0) return [...cur, st];
            const next = cur.slice();
            next[i] = st;
            return next;
          });
        } else if (ev.event === "done") {
          setPhase({ k: "done", done: JSON.parse(ev.data) as Done });
          return;
        }
      }
      setPhase({ k: "error", message: "The stream closed before the shift finished. The run may still complete; reload in a minute." });
    } catch {
      if (!ctl.signal.aborted) setPhase({ k: "error", message: "The stream was interrupted. The run may still complete; reload in a minute." });
    }
  }

  const done = phase.k === "done" ? phase.done : null;
  return (
    <section className={`panel ${s.card}`} aria-labelledby="live-title" data-testid="live-shift">
      <div className={s.cardHead}>
        <h2 id="live-title" className={s.cardTitle}>
          Run a shift now
        </h2>
        <span className="k">live · attests on Base</span>
      </div>
      <p className={s.note}>
        The agent checks this project right now: reads the repo, the live app and the chain, decides by the same rules, and
        attests the result. Limited to a few runs per visitor.
      </p>
      <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 16 }} onClick={run} disabled={phase.k === "running"}>
        {phase.k === "running" ? "Running…" : phase.k === "idle" ? "Run a shift now" : "Run again"}
      </button>
      {steps.length ? (
        <ol className={s.steps} aria-live="polite">
          {steps.map((st) => (
            <li key={st.key} className={s.step}>
              <i className={s.dot} data-state={st.state} aria-hidden="true" />
              <span>
                {st.label}
                <span className="sr-only"> ({st.state})</span>
                {st.detail ? <span className={s.detail}>{st.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {done ? (
        <div className={s.result} aria-live="polite">
          {done.status ? (
            <p className={s.note} style={{ margin: 0 }}>
              <i className={`sw sw-${done.status === "unavailable" ? "none" : done.status}`} aria-hidden="true" />{" "}
              <b>{STATUS_LABEL[done.status]}</b>: {STATUS_MEANING[done.status]}
            </p>
          ) : (
            <p className={s.err} style={{ margin: 0 }}>The run failed before it reached a verdict.</p>
          )}
          <p className={s.small} style={{ margin: "8px 0 0" }}>
            {done.attestationUid ? (
              <>
                attestation:{" "}
                <a className="ul" href={`https://base.easscan.org/attestation/view/${done.attestationUid}`} target="_blank" rel="noreferrer">
                  easscan
                </a>
              </>
            ) : done.attestSkipped ? (
              <>attestation: skipped ({SKIPPED[done.attestSkipped] ?? done.attestSkipped})</>
            ) : (
              <>attestation: none</>
            )}
            {done.txHash ? (
              <>
                {" · "}
                <a className="ul" href={`https://basescan.org/tx/${done.txHash}`} target="_blank" rel="noreferrer">
                  basescan tx
                </a>
              </>
            ) : null}
            {done.evidenceHash ? (
              <>
                {" · "}
                <a className="ul" href={`/api/v1/evidence/${done.evidenceHash}`} target="_blank" rel="noreferrer">
                  evidence
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {phase.k === "error" ? (
        <p className={s.err} role="alert">
          {phase.message}
        </p>
      ) : null}
    </section>
  );
}
