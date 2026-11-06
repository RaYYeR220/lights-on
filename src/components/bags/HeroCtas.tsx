"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { BagsForm } from "./BagsForm";

/** The two hero actions. "Check your bags" opens an address field in place; Escape puts the button back. */
export function HeroCtas({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className={className} data-open={open ? "" : undefined}>
      <Link className="btn btn-primary" href="/night">
        See last night&apos;s shift
      </Link>
      {open ? (
        <BagsForm
          autoFocus
          onCancel={() => {
            setOpen(false);
            requestAnimationFrame(() => button.current?.focus());
          }}
        />
      ) : (
        <button ref={button} type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Check your bags
        </button>
      )}
    </div>
  );
}
