"use client";

import { useEffect, useRef, useState } from "react";
import type { StripNight } from "@/lib/views/project";
import { nightLabel, reasonLines, STATUS_LABEL, STATUS_MEANING } from "@/lib/views/reasons";
import type { EvidenceBundle } from "@/lib/types";
import { EvidenceView } from "./EvidenceView";
import type { VerifyOutcome } from "./verifyInBrowser";
import { siteUrl } from "@/lib/site";
import s from "./project.module.css";

type Loaded = { state: "idle" | "loading" } | { state: "ok"; text: string; bundle: EvidenceBundle } | { state: "error"; message: string };

const swatch = (st: StripNight["status"]) =>
  st === "shipped" || st === "building" || st === "quiet" || st === "down" ? `sw-${st}` : "sw-none";

export const easscan = (uid: string) => `https://base.easscan.org/attestation/view/${uid}`;
export const basescanTx = (tx: string) => `https://basescan.org/tx/${tx}`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * The offline check for one night, ready to paste in a clone of the repo: fetch the published bundle, then verify it
 * against the attestation on Base (for a nightly root, the script fetches the row's Merkle proof from `--site`). Null
 * until the night has both an evidence hash and an attestation uid. Without a known watcher address the script falls
 * back to NEXT_PUBLIC_WATCHER_ADDRESS from the environment.
 */
export function verifyCommand(p: {
  site: string; slug: string; night: number; uid: string | null; evidenceHash: string | null; watcher: string | null;
}): string | null {
  if (!p.uid || !p.evidenceHash) return null;
  const file = `evidence-${p.slug}-${p.night}.json`;
  const site = p.site.replace(/\/+$/, "");
  const attester = p.watcher?.trim() ? ` --attester ${p.watcher.trim()}` : "";
  return [
    `curl -s ${site}/api/v1/evidence/${p.evidenceHash} -o ${file}`,
    `pnpm tsx scripts/verify-night.ts --network base --uid ${p.uid} --bundle ${file} --site ${site}${attester}`,
  ].join("\n");
}

/** "deploy between 20261104220756 and 20261105220853" -> readable Wayback capture times. */
function waybackNote(note: string): string {
  const fmt = (t: string) => `${Number(t.slice(6, 8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(t.slice(4, 6)) - 1]} ${t.slice(8, 10)}:${t.slice(10, 12)} UTC`;
  return note.replace(/\b(\d{14})\b/g, (m) => fmt(m));
}

export function NightDrawer({
  slug,
  night,
  watcher,
  onClose,
}: {
  slug: string;
  night: StripNight | null;
  watcher: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (night && !d.open) d.showModal();
    if (!night && d.open) d.close();
  }, [night]);

  return (
    <dialog
      ref={ref}
      className={s.drawer}
      aria-labelledby="night-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      data-testid="night-drawer"
    >
      {night ? <DrawerBody key={night.night} slug={slug} n={night} watcher={watcher} close={() => ref.current?.close()} /> : null}
    </dialog>
  );
}

/** One night's contents; keyed by night so its evidence and verify state start fresh for each night. */
function OfflineCheck({ cmd, watcherKnown }: { cmd: string | null; watcherKnown: boolean }) {
  if (!cmd) return <p className={s.small} style={{ marginTop: 12 }}>The offline check needs an attestation; this night has none yet.</p>;
  return (
    <div className={s.small} style={{ marginTop: 12 }}>
      <p>Offline, in a clone of the repo{watcherKnown ? "" : " (set NEXT_PUBLIC_WATCHER_ADDRESS to the watcher address first)"}:</p>
      <pre className={s.cmd} data-testid="verify-command">
        <code>{cmd}</code>
      </pre>
    </div>
  );
}

function DrawerBody({ slug, n, watcher, close }: { slug: string; n: StripNight; watcher: string | null; close: () => void }) {
  const hash = n.evidenceHash;
  const [ev, setEv] = useState<Loaded>(hash ? { state: "loading" } : { state: "idle" });
  const [verify, setVerify] = useState<{ running: boolean; out: VerifyOutcome | null }>({ running: false, out: null });

  useEffect(() => {
    if (!hash) return;
    const ac = new AbortController();
    fetch(`/api/v1/evidence/${hash}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "The evidence bundle for this night was not found." : `Evidence request failed (HTTP ${r.status}).`);
        const text = await r.text();
        setEv({ state: "ok", text, bundle: JSON.parse(text) as EvidenceBundle });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setEv({ state: "error", message: e instanceof Error ? e.message : "Evidence could not be loaded." });
      });
    return () => ac.abort();
  }, [hash]);

  async function runVerify() {
    setVerify({ running: true, out: null });
    try {
      const { verifyInBrowser } = await import("./verifyInBrowser");
      const out = await verifyInBrowser({
        hash: n.evidenceHash,
        evidence: ev.state === "ok" ? ev.text : null,
        uid: n.attestationUid,
        observed: n.observed,
        watcher,
        status: n.status,
        lit30: n.attestLit30,
        proof: n.attestProof,
        tx: n.attestTx,
      });
      setVerify({ running: false, out });
    } catch {
      setVerify({ running: false, out: { checks: [], summary: "The check could not run in this browser (network or RPC error). Try again.", match: false } });
    }
  }

  return (
        <div className={s.dIn}>
          <div className={s.dHead}>
            <h2 id="night-title" className={s.dTitle}>
              Night of {nightLabel(n.night, true)}
            </h2>
            <button type="button" className={s.close} onClick={close} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className={s.dSec}>
            <div className={s.srcHead} style={{ justifyContent: "flex-start", fontSize: 15 }}>
              <i className={`sw ${swatch(n.status)}`} aria-hidden="true" />
              {n.status ? (
                <span>
                  {STATUS_LABEL[n.status]}: <span className={s.meaning}>{STATUS_MEANING[n.status]}</span>
                </span>
              ) : (
                <span>No reading for this night</span>
              )}
            </div>
            <p className={s.small} style={{ margin: "8px 0 0" }}>
              {n.observed
                ? "Observed live by the nightly shift."
                : n.status
                  ? `Reconstructed history${n.reconstructedFrom ? ` (from ${n.reconstructedFrom.replace("+", " + ")})` : ""}. Never observed live, never attested.`
                  : "No row exists: the repo did not exist yet, or nothing could be reconstructed for this night."}
              {n.alsoReconstructed ? " A reconstructed reading exists too; the live one is shown." : ""}
            </p>
          </div>

          {n.status ? (
            <div className={s.dSec}>
              <h3>Why</h3>
              {n.reasons.length ? (
                <ul className={s.reasons}>
                  {reasonLines(n.reasons).map((r) => (
                    <li key={r.code}>
                      {r.text} <code>{r.code}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={s.note}>No reason codes were recorded for this night.</p>
              )}
              {n.note ? <p className={s.small} style={{ marginTop: 8 }}>Wayback: {waybackNote(n.note)}</p> : null}
            </div>
          ) : null}

          {n.status ? (
            <div className={s.dSec}>
              <h3>Explanation</h3>
              {n.summary ? (
                <p className={s.note}>{n.summary}</p>
              ) : n.templateSummary ? (
                <p className={s.note}>
                  {n.templateSummary} <span className={s.small}>(fixed template, no AI)</span>
                </p>
              ) : (
                <p className={s.note}>
                  Explanation unavailable{n.observed ? "." : ": reconstructed nights are not explained by AI."}
                </p>
              )}
              {n.notable.length ? (
                <ul className={s.reasons} style={{ marginTop: 8 }}>
                  {n.notable.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {n.founderNotes.length ? (
            <div className={s.dSec} data-testid="founder-notes">
              <h3>Founder note · REPORTED, never counted</h3>
              {n.founderNotes.map((f) => (
                <div key={`${f.at}-${f.note}`} className={s.src}>
                  <p className={s.note} style={{ marginTop: 0 }}>
                    {f.note}
                  </p>
                  <p className={s.small} style={{ margin: "6px 0 0" }}>
                    Signed by the verified founder {f.author.slice(0, 6)}…{f.author.slice(-4)} on {f.at.slice(0, 10)}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {n.evidenceHash ? (
            <div className={s.dSec}>
              <h3>Evidence</h3>
              {ev.state === "loading" ? <p className={s.small}>Loading the evidence bundle…</p> : null}
              {ev.state === "error" ? <p className={s.err}>{ev.message}</p> : null}
              {ev.state === "ok" ? <EvidenceView bundle={ev.bundle} /> : null}
            </div>
          ) : null}

          {n.status ? (
            <div className={s.dSec}>
              <h3>Proof</h3>
              <dl className={s.kv}>
                <dt>Evidence</dt>
                <dd>
                  {n.evidenceHash ? (
                    <a className="ul" href={`/api/v1/evidence/${n.evidenceHash}`} target="_blank" rel="noreferrer">
                      {n.evidenceHash}
                    </a>
                  ) : (
                    "none recorded"
                  )}
                </dd>
                <dt>{n.attestRoot ? "Root attestation" : "Attestation"}</dt>
                <dd data-testid="attestation-state">
                  {n.attestationUid ? (
                    <a className="ul" href={easscan(n.attestationUid)} target="_blank" rel="noreferrer">
                      {n.attestationUid}
                    </a>
                  ) : n.observed ? (
                    "not attested yet"
                  ) : (
                    "reconstructed, never attested"
                  )}
                </dd>
                {n.attestTx ? (
                  <>
                    <dt>Tx</dt>
                    <dd>
                      <a className="ul" href={basescanTx(n.attestTx)} target="_blank" rel="noreferrer">
                        {n.attestTx}
                      </a>
                    </dd>
                  </>
                ) : null}
                {n.attestRoot && n.attestProof ? (
                  <>
                    <dt>Merkle proof</dt>
                    <dd data-testid="merkle-proof">
                      {n.attestProof.length} step{n.attestProof.length === 1 ? "" : "s"} → root <code>{short(n.attestRoot)}</code>
                      {n.attestTx && n.attestationUid ? <> attested in tx <code>{short(n.attestTx)}</code></> : null}
                      {n.attestTx && !n.attestationUid ? <>, sent in tx <code>{short(n.attestTx)}</code>, awaiting confirmation</> : null}
                    </dd>
                  </>
                ) : null}
                {n.attestLit30 !== null ? (
                  <>
                    <dt>Lit30 in the leaf</dt>
                    <dd data-testid="leaf-lit30">{n.attestLit30} of the last 30 nights</dd>
                  </>
                ) : null}
                {n.manifestHash ? (
                  <>
                    <dt>Manifest</dt>
                    <dd>
                      <a className="ul" href={`/api/v1/manifest/${n.manifestHash}`} target="_blank" rel="noreferrer">
                        View night manifest
                      </a>
                    </dd>
                  </>
                ) : null}
              </dl>
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={runVerify} disabled={verify.running || ev.state === "loading"}>
                {verify.running ? "Verifying…" : "Verify in this browser"}
              </button>
              {verify.out ? (
                <ul className={s.checks} data-testid="verify-checks" aria-live="polite">
                  {verify.out.checks.map((c) => (
                    <li key={c.key}>
                      <span className={c.state === "pass" ? s.pass : c.state === "fail" ? s.fail : s.skip}>
                        {c.state === "pass" ? "PASS" : c.state === "fail" ? "FAIL" : "N/A"}
                      </span>
                      <span>{c.label}</span>
                    </li>
                  ))}
                  {verify.out.proofLine ? <li className={s.small} data-testid="verify-proof">{verify.out.proofLine}</li> : null}
                  {verify.out.summary ? <li className={s.small}>{verify.out.summary}</li> : null}
                </ul>
              ) : null}
              <OfflineCheck cmd={verifyCommand({ site: siteUrl(), slug, night: n.night, uid: n.attestationUid, evidenceHash: n.evidenceHash, watcher })} watcherKnown={!!watcher} />
            </div>
          ) : null}
        </div>
  );
}
