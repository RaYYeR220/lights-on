"use client";

import { useState } from "react";
import s from "./backer.module.css";

type State = { k: "idle" } | { k: "busy" } | { k: "ok" } | { k: "error"; message: string };

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const SERVER: Record<string, string> = {
  endpoint_rejected: "Your browser's push service did not accept our test message, so nothing was saved. Try another browser.",
  bad_request: "This browser sent a subscription we cannot use. Try another browser.",
  nothing_to_follow: "There is nothing to follow for this wallet yet.",
  push_not_configured: "Web push is not switched on for this deployment yet.",
  subscriptions_full: "Web push is full right now. Use Telegram instead.",
  misconfigured: "Web push is not switched on for this deployment yet.",
};

/** Morning briefings as web push: registers /sw.js, subscribes with the VAPID key, saves the follow server side. */
export function PushSubscribe({ address, vapidKey }: { address: string; vapidKey: string }) {
  const [st, setSt] = useState<State>({ k: "idle" });

  async function subscribe() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setSt({ k: "error", message: "This browser does not support web push. Telegram works everywhere." });
      return;
    }
    setSt({ k: "busy" });
    let sub: PushSubscription | null = null;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setSt({ k: "error", message: "Notifications are blocked for this site. Allow them in the browser settings, then try again." });
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), addresses: [address] }),
      });
      if (res.ok) {
        setSt({ k: "ok" });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 429) {
        const sec = Number(res.headers.get("retry-after")) || 3600;
        setSt({ k: "error", message: `Too many new subscriptions from this network. Try again in ${Math.ceil(sec / 60)} min.` });
      } else {
        setSt({ k: "error", message: SERVER[body.error ?? ""] ?? `Subscribing failed (HTTP ${res.status}).` });
      }
      if (res.status === 400) await sub.unsubscribe().catch(() => undefined);
    } catch {
      setSt({ k: "error", message: "Subscribing failed in this browser. Try again, or use Telegram." });
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={subscribe} disabled={st.k === "busy" || st.k === "ok"}>
        {st.k === "busy" ? "Subscribing…" : st.k === "ok" ? "Subscribed in this browser" : "Get it as a browser notification"}
      </button>
      {st.k === "ok" ? <p className={s.ok}>Done. The next briefing arrives after the 05:00 UTC shift.</p> : null}
      {st.k === "error" ? (
        <p className={s.err} role="alert">
          {st.message}
        </p>
      ) : null}
    </div>
  );
}
