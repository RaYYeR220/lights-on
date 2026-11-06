"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider, useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { wagmiConfig } from "./wagmiConfig";
import { claimError } from "./messages";
import s from "./claim.module.css";

export interface ClaimNight {
  night: number;
  status: string | null;
  observed: boolean;
}

export interface ClaimProps {
  slug: string;
  name: string;
  liveUrl: string | null;
  founderWallet: string | null;
  claimedBy: string | null;
  nights: ClaimNight[];
  site: string;
}

type Purpose = "claim" | "note" | "draft";
interface Issued {
  nonce: string;
  message: string;
  proof?: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (n: number) => `${n % 100} ${MONTHS[(Math.floor(n / 100) % 100) - 1]}`;

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    return r.ok ? { ok: true, data: j } : { ok: false, message: claimError(j.error, r.status) };
  } catch {
    return { ok: false, message: "The request did not reach the server. Check your connection and try again." };
  }
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard blocked: the text stays selectable */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function Flow(p: ClaimProps) {
  const { address, isConnected, connector } = useAccount();
  const { connectors, connect, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [claimedBy, setClaimedBy] = useState<string | null>(p.claimedBy);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; aiOk: boolean } | null>(null);
  const [noteNight, setNoteNight] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const isFounder = same(address, p.founderWallet);
  const isClaimer = same(address, claimedBy);
  const wellKnown = p.liveUrl ? new URL("/.well-known/lights-on.txt", p.liveUrl).toString() : null;

  async function nonce(purpose: Purpose, night?: number): Promise<Issued | null> {
    if (!address) return null;
    const r = await post<Issued>("/api/claim/nonce", { slug: p.slug, address, purpose, ...(night !== undefined ? { night } : {}) });
    if (!r.ok) {
      setErr(r.message);
      return null;
    }
    return r.data;
  }

  async function sign(message: string): Promise<string | null> {
    try {
      return await signMessageAsync({ message });
    } catch {
      setErr("The signature was cancelled in the wallet. Nothing was sent.");
      return null;
    }
  }

  async function getClaimMessage() {
    setErr(null);
    setBusy("nonce");
    const n = await nonce("claim");
    if (n) setIssued(n);
    setBusy(null);
  }

  async function signClaim() {
    if (!issued) return;
    setErr(null);
    setBusy("claim");
    const sig = await sign(issued.message);
    if (sig) {
      const r = await post<{ ok: true; method: string }>("/api/claim", { slug: p.slug, message: issued.message, signature: sig });
      if (r.ok) {
        setClaimedBy(address ?? null);
        setOkMsg(
          r.data.method === "vibestarter_founder"
            ? "Claimed: this wallet is the campaign's founder wallet on Vibestarter."
            : "Claimed: the proof line was found on the live app.",
        );
      } else {
        setErr(r.message);
        if (/expired|already used/.test(r.message)) setIssued(null);
      }
    }
    setBusy(null);
  }

  async function makeDraft() {
    setErr(null);
    setBusy("draft");
    const n = await nonce("draft");
    const sig = n ? await sign(n.message) : null;
    if (n && sig) {
      const r = await post<{ text: string; aiOk: boolean }>("/api/claim/draft", { slug: p.slug, message: n.message, signature: sig });
      if (r.ok) setDraft(r.data);
      else setErr(r.message);
    }
    setBusy(null);
  }

  async function addNote() {
    if (noteNight === null) return;
    setErr(null);
    setOkMsg(null);
    if (!note.trim()) {
      setErr("Write the note first (plain text, up to 280 characters).");
      return;
    }
    setBusy("note");
    const n = await nonce("note", noteNight);
    const sig = n ? await sign(n.message) : null;
    if (n && sig) {
      const r = await post<{ ok: true }>("/api/notes", { slug: p.slug, night: noteNight, note, message: n.message, signature: sig });
      if (r.ok) {
        setOkMsg(`Note added to the night of ${day(noteNight)}. It shows in that night's drawer on the project page within 5 minutes.`);
        setNote("");
      } else setErr(r.message);
    }
    setBusy(null);
  }

  const badgeUrl = `${p.site}/badge/${p.slug}`;
  const pageUrl = `${p.site}/p/${p.slug}`;

  return (
    <div className={s.flow} data-testid="claim-flow">
      <section className={`panel ${s.step}`} aria-labelledby="step-connect">
        <h2 id="step-connect" className={s.stepTitle}>
          <span className={s.num}>1</span> Connect the founder wallet
        </h2>
        {isConnected && address ? (
          <div className={s.row}>
            <span className={s.addr}>
              {short(address)} <span className="k">via {connector?.name ?? "wallet"}</span>
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <p className={s.note}>Only a signature is asked for. Nothing is sent on chain and no funds move.</p>
            <div className={s.row}>
              {connectors.map((c) => (
                <button key={c.uid} type="button" className="btn btn-ghost btn-sm" disabled={isPending} onClick={() => connect({ connector: c })}>
                  {c.id === "injected" ? "Browser wallet" : c.name}
                </button>
              ))}
            </div>
            {connectError ? (
              <p className={s.err} role="alert">
                {/provider not found/i.test(connectError.message) || String(connectError.name) === "ProviderNotFoundError"
                  ? "No browser wallet found. Install one (MetaMask, Rabby, Coinbase Wallet), or open this page in your wallet's browser."
                  : "The wallet did not connect. Unlock it and try again."}
              </p>
            ) : null}
          </>
        )}
      </section>

      {isConnected && address && !isClaimer ? (
        <section className={`panel ${s.step}`} aria-labelledby="step-prove">
          <h2 id="step-prove" className={s.stepTitle}>
            <span className={s.num}>2</span> Prove it is yours
          </h2>
          {claimedBy ? <p className={s.note}>Claimed already by {short(claimedBy)}. Only the Vibestarter founder wallet can take it over.</p> : null}
          {!issued ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={getClaimMessage} disabled={busy !== null}>
              {busy === "nonce" ? "Preparing…" : "Get my claim message"}
            </button>
          ) : (
            <div className={s.options}>
              <div className={s.option}>
                <h3>a. I&apos;m the Vibestarter founder</h3>
                <p className={s.note}>
                  {p.founderWallet
                    ? isFounder
                      ? "This wallet is the campaign's founder wallet on Vibestarter: signing is enough."
                      : `The campaign's founder wallet is ${short(p.founderWallet)}; this wallet is a different one, so use option b.`
                    : "This project has no Vibestarter campaign, so use option b."}
                </p>
                <button type="button" className="btn btn-primary btn-sm" onClick={signClaim} disabled={busy !== null || !isFounder}>
                  {busy === "claim" ? "Waiting for the signature…" : "Sign and claim"}
                </button>
              </div>
              <div className={s.option}>
                <h3>b. Publish a proof line on the live app</h3>
                {wellKnown && issued.proof ? (
                  <>
                    <p className={s.note}>
                      Put this exact line in <code>{wellKnown}</code> (plain text, within 10 minutes), then sign:
                    </p>
                    <div className={s.proof}>
                      <code data-testid="proof-line">{issued.proof}</code>
                      <Copy text={issued.proof} />
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={signClaim} disabled={busy !== null}>
                      {busy === "claim" ? "Waiting for the signature…" : "I published it: sign and claim"}
                    </button>
                  </>
                ) : (
                  <p className={s.note}>This project has no live URL on the watch, so there is nowhere to publish the line.</p>
                )}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {isConnected && address && isClaimer ? (
        <section className={`panel ${s.step}`} aria-labelledby="step-tools">
          <h2 id="step-tools" className={s.stepTitle}>
            <span className={s.num}>✓</span> Founder tools for {p.name}
          </h2>
          <div className={s.tool}>
            <h3>Badge</h3>
            {/* eslint-disable-next-line @next/next/no-img-element -- an SVG served by our own route */}
            <img src={`/badge/${p.slug}`} alt={`Lights On badge for ${p.name}`} height={20} />
            <div className={s.proof}>
              <code>{`[![Lights On](${badgeUrl})](${pageUrl})`}</code>
              <Copy text={`[![Lights On](${badgeUrl})](${pageUrl})`} label="Copy Markdown" />
            </div>
            <div className={s.proof}>
              <code>{`<a href="${pageUrl}"><img src="${badgeUrl}" alt="Lights On"></a>`}</code>
              <Copy text={`<a href="${pageUrl}"><img src="${badgeUrl}" alt="Lights On"></a>`} label="Copy HTML" />
            </div>
          </div>
          <div className={s.tool}>
            <h3>Draft a backer update</h3>
            <p className={s.note}>A draft from the last 30 nights of evidence, every claim tied to a night. Edit it, then post it wherever you update backers.</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={makeDraft} disabled={busy !== null}>
              {busy === "draft" ? "Signing and drafting…" : "Sign and draft"}
            </button>
            {draft ? (
              <>
                <textarea className={s.area} readOnly value={draft.text} rows={8} aria-label="Draft update" />
                <div className={s.row}>
                  <Copy text={draft.text} />
                  <span className="k">{draft.aiOk ? "written with AI from the evidence" : "fixed template (AI unavailable)"}</span>
                </div>
              </>
            ) : null}
          </div>
          <div className={s.tool}>
            <h3>Add a note to a night</h3>
            <p className={s.note}>Shown on that night as a founder note: reported, never counted toward the status.</p>
            <div className={s.nights} role="radiogroup" aria-label="Night">
              {p.nights.map((n) => (
                <button
                  key={n.night}
                  type="button"
                  role="radio"
                  aria-checked={noteNight === n.night}
                  className={`${s.lite} ${n.status ? s[n.status] ?? "" : s.none} ${n.observed ? "" : s.rec}`}
                  title={`${day(n.night)}: ${n.status ?? "no reading"}`}
                  aria-label={`${day(n.night)}: ${n.status ?? "no reading"}`}
                  disabled={!n.status}
                  onClick={() => setNoteNight(n.night)}
                />
              ))}
            </div>
            <p className="k">{noteNight ? `Night of ${day(noteNight)}` : "Pick a night (last 30)."}</p>
            <textarea
              className={s.area}
              rows={3}
              maxLength={280}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What happened that night, in plain words"
              aria-label="Note"
            />
            <div className={s.row}>
              <button type="button" className="btn btn-primary btn-sm" onClick={addNote} disabled={busy !== null || noteNight === null}>
                {busy === "note" ? "Signing…" : "Sign and add the note"}
              </button>
              <span className="k">{note.length}/280</span>
            </div>
          </div>
        </section>
      ) : null}

      <div aria-live="polite">
        {okMsg ? <p className={s.ok}>{okMsg}</p> : null}
        {err ? (
          <p className={s.err} role="alert">
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const queryClient = new QueryClient();

/** Wallet providers live only on this route, so no other page loads wallet code. */
export function ClaimFlow(props: ClaimProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Flow {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
