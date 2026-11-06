"use client";

import { useEffect, useState } from "react";

/** "3d 04:12:09" to an ISO time, ticking each second; "closed" once it passes. */
export function formatLeft(ms: number): string {
  if (ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${d > 0 ? `${d}d ` : ""}${hh}:${mm}:${ss}`;
}

export function Countdown({ to, doneText = "closed" }: { to: string; doneText?: string }) {
  const end = Date.parse(to);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return <b suppressHydrationWarning>{now === null ? "…" : end - now <= 0 ? doneText : formatLeft(end - now)}</b>;
}
