"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import s from "./add.module.css";

type Result =
  | { k: "idle" }
  | { k: "busy" }
  | { k: "queued"; slug: string | null }
  | { k: "exists"; slug: string }
  | { k: "error"; message: string };

type Field = "liveUrl" | "repo" | "contract";

const REPO = /^(?:https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Client-side checks that mirror the server's; the server stays the authority. */
export function validateWatch(v: { liveUrl: string; repo: string; contract: string }): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  const url = v.liveUrl.trim();
  if (!url) e.liveUrl = "A live URL is required: the agent checks what reached users there.";
  else {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("bad");
    } catch {
      e.liveUrl = "Use a full web address, like https://app.example.xyz.";
    }
  }
  if (v.repo.trim() && !REPO.test(v.repo.trim())) e.repo = "Use owner/name, or a github.com or gitlab.com repo URL.";
  if (v.contract.trim() && !ADDRESS.test(v.contract.trim())) e.contract = "Use a 0x contract address on Base (42 characters).";
  return e;
}

const SERVER: Record<string, string> = {
  bad_request: "The form did not send what the watch needs. Check the fields and try again.",
  invalid_url: "That live URL is not a public http(s) address.",
  invalid_repo: "That repo is not a GitHub or GitLab owner/name.",
  invalid_contract: "That contract is not a valid address.",
  unreachable: "The live URL did not answer (or answered with a server error), so there is nothing to watch yet.",
  blocked_url: "That address points somewhere the watcher is not allowed to fetch (a private or local network).",
  misconfigured: "Adding projects is switched off on this deployment right now.",
};

export function WatchForm() {
  const [v, setV] = useState({ liveUrl: "", repo: "", contract: "" });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [res, setRes] = useState<Result>({ k: "idle" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateWatch(v);
    setErrors(found);
    if (Object.keys(found).length) {
      setRes({ k: "idle" });
      return;
    }
    setRes({ k: "busy" });
    const body: Record<string, string> = { liveUrl: v.liveUrl.trim() };
    if (v.repo.trim()) body.repo = v.repo.trim();
    if (v.contract.trim()) body.contract = v.contract.trim();
    try {
      const r = await fetch("/api/v1/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { slug?: string; status?: string; error?: string };
      if (r.ok && j.status === "exists" && j.slug) setRes({ k: "exists", slug: j.slug });
      else if (r.ok) setRes({ k: "queued", slug: j.slug ?? null });
      else if (r.status === 429) {
        const sec = Number(r.headers.get("retry-after")) || 0;
        const wait = sec > 5400 ? `${Math.ceil(sec / 3600)} h` : sec > 90 ? `${Math.ceil(sec / 60)} min` : sec ? `${sec} s` : "a while";
        setRes({ k: "error", message: `Too many projects added from this network today. Try again in ${wait}.` });
      } else setRes({ k: "error", message: SERVER[j.error ?? ""] ?? `The watch request failed (HTTP ${r.status}). Try again.` });
    } catch {
      setRes({ k: "error", message: "The request did not reach the server. Check your connection and try again." });
    }
  }

  const field = (name: Field, label: string, hint: string, opts: { required?: boolean; placeholder: string; mono?: boolean }) => (
    <div className={s.field}>
      <label htmlFor={`w-${name}`} className={s.label}>
        {label} {opts.required ? <span className={s.req}>required</span> : <span className={s.opt}>optional</span>}
      </label>
      <input
        id={`w-${name}`}
        name={name}
        className={s.input}
        value={v[name]}
        onChange={(e) => {
          setV({ ...v, [name]: e.target.value });
          if (errors[name]) setErrors({ ...errors, [name]: undefined });
        }}
        placeholder={opts.placeholder}
        inputMode={name === "liveUrl" ? "url" : "text"}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={`w-${name}-hint`}
      />
      <p id={`w-${name}-hint`} className={errors[name] ? s.fieldErr : s.hint}>
        {errors[name] ?? hint}
      </p>
    </div>
  );

  return (
    <form className={`panel ${s.form}`} onSubmit={submit} noValidate data-testid="watch-form">
      {field("liveUrl", "Live URL", "Where users reach the project. The agent fingerprints its deploys.", {
        required: true,
        placeholder: "https://app.example.xyz",
      })}
      {field("repo", "Repo", "Public GitHub or GitLab repo, for the code work behind each deploy.", { placeholder: "owner/name" })}
      {field("contract", "Contract on Base", "A contract the project deployed; new deploys by its deployer count as shipped.", {
        placeholder: "0x…",
      })}
      <div className={s.actions}>
        <button type="submit" className="btn btn-primary" disabled={res.k === "busy"}>
          {res.k === "busy" ? "Checking the site…" : "Add to the watch"}
        </button>
        <span className="k">3 per network per day</span>
      </div>
      <div aria-live="polite" data-testid="watch-result">
        {res.k === "queued" ? (
          <p className={s.ok}>
            Queued. The first check is running now; if the site answers, the project&apos;s page appears
            {res.slug ? (
              <>
                {" "}
                at{" "}
                <Link className="ul" href={`/p/${res.slug}`}>
                  /p/{res.slug}
                </Link>
              </>
            ) : null}{" "}
            within a few minutes. It is unlisted: it joins the building only after review.
          </p>
        ) : null}
        {res.k === "exists" ? (
          <p className={s.ok}>
            Already on the watch:{" "}
            <Link className="ul" href={`/p/${res.slug}`}>
              /p/{res.slug}
            </Link>
          </p>
        ) : null}
        {res.k === "error" ? (
          <p className={s.err} role="alert">
            {res.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
