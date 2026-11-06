"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { normalizeBagsInput } from "./address";
import s from "./bags.module.css";

export function BagsForm({
  autoFocus,
  onCancel,
  className,
  size = "hero",
}: {
  autoFocus?: boolean;
  onCancel?: () => void;
  className?: string;
  size?: "hero" | "page";
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = normalizeBagsInput(value);
    if (!v) {
      setError(value.trim() ? "Use a 0x address or an ENS name like vitalik.eth." : "Paste a wallet address or an ENS name.");
      input.current?.focus();
      return;
    }
    setError(null);
    router.push(`/b/${encodeURIComponent(v)}`);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <form className={`${s.form} ${size === "page" ? s.page : ""} ${className ?? ""}`} onSubmit={submit} noValidate>
      <div className={s.field} data-invalid={error ? "" : undefined}>
        <label htmlFor={`${id}-addr`} className="sr-only">
          Wallet address or ENS name
        </label>
        <input
          id={`${id}-addr`}
          ref={input}
          className={s.input}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKey}
          placeholder="0x… or name.eth"
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <button type="submit" className={s.go} aria-label="Check these bags">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <p id={`${id}-err`} className={s.err} role="alert" hidden={!error}>
        {error}
      </p>
    </form>
  );
}
